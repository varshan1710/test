// controllers/espController.js
// Handles all ESP32 sensor integration endpoints.
//
// Conceptual flow:
//   1. Volunteer starts a food test for a donation → createFoodTest()
//   2. ESP32 polls for its active test           → getActiveTest()
//   3. ESP32 sends sensor readings               → addReading()
//   4. Test is completed                         → completeTest()
//   5. Volunteer/admin retrieves test result     → getTest()
//   6. Admin registers a new device              → registerDevice()
//
// Security notes:
//   - createFoodTest, completeTest, getTest require a valid volunteer JWT.
//   - getActiveTest, addReading require a valid ESP32 device token.
//   - A device can only submit readings for its OWN active test.
//   - The NGO is NEVER determined from the device — only from the Donation.

const asyncHandler = require('express-async-handler');
const EspDevice = require('../models/EspDevice');
const FoodTest = require('../models/FoodTest');
const Donation = require('../models/Donation');
const { calculateFoodQualityScore } = require('../utils/foodQualityScorer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a sequential, human-readable test ID like "TEST-0001". */
async function generateTestId() {
  const count = await FoodTest.countDocuments();
  return `TEST-${String(count + 1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// POST /api/esp/tests/start
// Volunteer initiates a new food-testing session for a specific donation.
// @access Private (volunteer)
// ---------------------------------------------------------------------------
const createFoodTest = asyncHandler(async (req, res) => {
  const { donationId, deviceId } = req.body;

  if (!donationId || !deviceId) {
    res.status(400);
    throw new Error('donationId and deviceId are required');
  }

  // Validate the donation exists
  const donation = await Donation.findById(donationId);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  // Donation must be in a testable state (volunteer has been assigned)
  const testableStatuses = ['out_for_pickup', 'assigned_pending_volunteer'];
  if (!testableStatuses.includes(donation.status)) {
    res.status(400);
    throw new Error(`Cannot start a food test for a donation with status "${donation.status}". Donation must be in out_for_pickup or assigned_pending_volunteer state.`);
  }

  // Only the assigned volunteer can start a test for this donation
  const assignedId = (donation.assignedVolunteer?._id || donation.assignedVolunteer)?.toString();
  if (assignedId && assignedId !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the assigned volunteer can start a food test for this donation');
  }

  // Validate the device is registered and active
  const device = await EspDevice.findOne({ deviceId, status: 'active' });
  if (!device) {
    res.status(404);
    throw new Error(`Device "${deviceId}" not found or inactive. Please register the device first (POST /api/esp/devices).`);
  }

  // Cancel any prior active test for the same donation (idempotency)
  await FoodTest.updateMany(
    { donationId, status: 'active' },
    { $set: { status: 'cancelled' } }
  );

  const testId = await generateTestId();

  const foodTest = await FoodTest.create({
    testId,
    deviceId,
    donationId,
    volunteerId: req.user._id,
    status: 'active',
    readings: [],
    foodQualityScore: null,
    startedAt: new Date(),
  });

  // Mark device as seen
  await EspDevice.findOneAndUpdate({ deviceId }, { lastSeen: new Date() });

  console.log(`[esp] Food test ${testId} created — device: ${deviceId}, donation: ${donationId}, volunteer: ${req.user.name}`);

  res.status(201).json({
    success: true,
    data: {
      testId: foodTest.testId,
      testSessionId: foodTest._id,
      deviceId: foodTest.deviceId,
      donationId: foodTest.donationId,
      status: foodTest.status,
      startedAt: foodTest.startedAt,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/esp/tests/active/:deviceId
// ESP32 polls this endpoint to discover its currently active test.
// @access Device token auth (espAuth middleware)
// ---------------------------------------------------------------------------
const getActiveTest = asyncHandler(async (req, res) => {
  const { deviceId } = req.params;

  // Confirm device exists
  const device = await EspDevice.findOne({ deviceId, status: 'active' });
  if (!device) {
    return res.status(404).json({ success: false, message: `Device "${deviceId}" not found or inactive` });
  }

  // Update last seen
  await EspDevice.findOneAndUpdate({ deviceId }, { lastSeen: new Date() });

  const activeTest = await FoodTest.findOne({ deviceId, status: 'active' }).sort({ startedAt: -1 });

  if (!activeTest) {
    return res.json({ success: true, active: false, message: 'No active food test for this device' });
  }

  res.json({
    success: true,
    active: true,
    data: {
      testId: activeTest.testId,
      testSessionId: activeTest._id,
      donationId: activeTest.donationId,
      startedAt: activeTest.startedAt,
      readingCount: activeTest.readings.length,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/esp/tests/:testId/readings
// ESP32 sends sensor readings for its active test (multiple calls allowed).
// @access Device token auth (espAuth middleware)
// ---------------------------------------------------------------------------
const addReading = asyncHandler(async (req, res) => {
  const { testId } = req.params;
  const { deviceId, temperature, humidity, mqValue } = req.body;

  // Validate required fields
  if (temperature == null || humidity == null || mqValue == null) {
    res.status(400);
    throw new Error('temperature, humidity, and mqValue are required');
  }

  // Validate numeric types
  if (typeof temperature !== 'number' || typeof humidity !== 'number' || typeof mqValue !== 'number') {
    res.status(400);
    throw new Error('temperature, humidity, and mqValue must be numbers');
  }

  // Sanity-check ranges (reject clearly impossible values from a malfunctioning sensor)
  if (temperature < -40 || temperature > 80) {
    res.status(400);
    throw new Error(`temperature ${temperature}°C is out of sensor range`);
  }
  if (humidity < 0 || humidity > 100) {
    res.status(400);
    throw new Error(`humidity ${humidity}% is out of range`);
  }
  if (mqValue < 0 || mqValue > 4095) {
    res.status(400);
    throw new Error(`mqValue ${mqValue} is out of ADC range (0–4095)`);
  }

  // Find the active test for this device
  const foodTest = await FoodTest.findOne({ testId, status: 'active' });
  if (!foodTest) {
    res.status(404);
    throw new Error(`No active food test found with ID "${testId}"`);
  }

  // Security: confirm the reading device matches the test's device
  const submittedDeviceId = deviceId || req.deviceId;
  if (submittedDeviceId && foodTest.deviceId !== submittedDeviceId) {
    res.status(403);
    throw new Error(`Device "${submittedDeviceId}" is not associated with test "${testId}". Device "${foodTest.deviceId}" is assigned to this test.`);
  }

  // Append the reading
  foodTest.readings.push({
    temperature,
    humidity,
    mqValue,
    recordedAt: new Date(),
  });

  await foodTest.save();

  // Update device last-seen
  await EspDevice.findOneAndUpdate({ deviceId: foodTest.deviceId }, { lastSeen: new Date() });

  console.log(`[esp] Reading added to ${testId}: temp=${temperature}°C, hum=${humidity}%, mq=${mqValue} (total: ${foodTest.readings.length})`);

  res.json({
    success: true,
    data: {
      testId: foodTest.testId,
      readingCount: foodTest.readings.length,
      receivedAt: new Date(),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/esp/tests/:testId/complete
// Finalise the test: calculate the food quality score from all readings.
// Can be called by the volunteer (JWT) after confirming the test is done.
// @access Private (volunteer) OR device token auth
// ---------------------------------------------------------------------------
const completeTest = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  const foodTest = await FoodTest.findOne({ testId });
  if (!foodTest) {
    res.status(404);
    throw new Error(`Food test "${testId}" not found`);
  }

  if (foodTest.status === 'completed') {
    // Idempotent — return the existing result
    return res.json({
      success: true,
      alreadyCompleted: true,
      data: {
        testId: foodTest.testId,
        foodQualityScore: foodTest.foodQualityScore,
        sampleCount: foodTest.readings.length,
        completedAt: foodTest.completedAt,
      },
    });
  }

  if (foodTest.status === 'cancelled') {
    res.status(400);
    throw new Error(`Food test "${testId}" has been cancelled and cannot be completed`);
  }

  // Calculate score
  const scoreResult = calculateFoodQualityScore(foodTest.readings);

  foodTest.status = 'completed';
  foodTest.completedAt = new Date();
  foodTest.foodQualityScore = scoreResult ? scoreResult.foodQualityScore : null;

  await foodTest.save();

  console.log(`[esp] Test ${testId} completed — score: ${foodTest.foodQualityScore}% (${foodTest.readings.length} readings)`);

  res.json({
    success: true,
    data: {
      testId: foodTest.testId,
      foodQualityScore: foodTest.foodQualityScore,
      sampleCount: foodTest.readings.length,
      breakdown: scoreResult?.breakdown || null,
      completedAt: foodTest.completedAt,
      disclaimer: 'This score is a prototype indicator only and is not a certified food-safety assessment.',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/esp/tests/:testId
// Retrieve full test details including score.
// @access Private (any authenticated user)
// ---------------------------------------------------------------------------
const getTest = asyncHandler(async (req, res) => {
  const foodTest = await FoodTest.findOne({ testId: req.params.testId })
    .populate('donationId', 'foodName status acceptedBy')
    .populate('volunteerId', 'name email');

  if (!foodTest) {
    res.status(404);
    throw new Error(`Food test "${req.params.testId}" not found`);
  }

  res.json({ success: true, data: foodTest });
});

// ---------------------------------------------------------------------------
// GET /api/esp/tests/donation/:donationId/latest
// Get the latest completed test for a donation (used by foodSafetyReview).
// @access Private (volunteer, ngo, admin)
// ---------------------------------------------------------------------------
const getLatestTestForDonation = asyncHandler(async (req, res) => {
  const Donation = require('../models/Donation');
  const donation = await Donation.findById(req.params.donationId);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  // 1. Check for a completed test
  let foodTest = await FoodTest.findOne(
    { donationId: req.params.donationId, status: 'completed' },
    null,
    { sort: { completedAt: -1 } }
  );

  if (foodTest) {
    return res.json({ success: true, data: foodTest });
  }

  // 2. Check for an active test with readings and auto-complete if readings exist
  const activeTest = await FoodTest.findOne(
    { donationId: req.params.donationId, status: 'active' },
    null,
    { sort: { startedAt: -1 } }
  );

  if (activeTest) {
    if (activeTest.readings && activeTest.readings.length > 0) {
      const scoreResult = calculateFoodQualityScore(activeTest.readings);
      activeTest.status = 'completed';
      activeTest.completedAt = new Date();
      activeTest.foodQualityScore = scoreResult ? scoreResult.foodQualityScore : null;
      await activeTest.save();
      console.log(`[esp] Auto-completed test ${activeTest.testId} for donation ${req.params.donationId} — Score: ${activeTest.foodQualityScore}%`);
      return res.json({ success: true, data: activeTest });
    }
    return res.json({ success: true, data: activeTest, message: 'Active ESP32 test in progress, awaiting readings' });
  }

  res.json({ success: true, data: null, message: 'No completed food test found for this donation' });
});

// ---------------------------------------------------------------------------
// POST /api/esp/devices
// Admin registers a new ESP32 device.
// @access Private (admin)
// ---------------------------------------------------------------------------
const registerDevice = asyncHandler(async (req, res) => {
  const { deviceId, label } = req.body;

  if (!deviceId) {
    res.status(400);
    throw new Error('deviceId is required');
  }

  // Upsert — safe to call multiple times for the same device
  const device = await EspDevice.findOneAndUpdate(
    { deviceId },
    { deviceId, label: label || '', status: 'active' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`[esp] Device registered/updated: ${deviceId}`);

  res.status(201).json({ success: true, data: device });
});

// ---------------------------------------------------------------------------
// GET /api/esp/devices
// List all registered devices.
// @access Private (admin)
// ---------------------------------------------------------------------------
const listDevices = asyncHandler(async (req, res) => {
  const devices = await EspDevice.find().sort({ createdAt: -1 });
  res.json({ success: true, count: devices.length, data: devices });
});

// ---------------------------------------------------------------------------
// GET /api/esp/devices/:deviceId/tests
// List all tests run by a device.
// @access Private (admin)
// ---------------------------------------------------------------------------
const getDeviceTests = asyncHandler(async (req, res) => {
  const tests = await FoodTest.find({ deviceId: req.params.deviceId })
    .populate('donationId', 'foodName status')
    .sort({ startedAt: -1 })
    .limit(50);

  res.json({ success: true, count: tests.length, data: tests });
});

module.exports = {
  createFoodTest,
  getActiveTest,
  addReading,
  completeTest,
  getTest,
  getLatestTestForDonation,
  registerDevice,
  listDevices,
  getDeviceTests,
};
