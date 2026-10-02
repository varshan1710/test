// controllers/donationController.js
const asyncHandler = require('express-async-handler');
const Donation = require('../models/Donation');
const NGO = require('../models/NGO');
const User = require('../models/User');
const {
  recommendNearestNGOs,
  sortByPriority,
  detectDuplicateOrSuspicious,
  getEligibleNGOs,
  getEligibleVolunteers,
} = require('../utils/smartFeatures');
const { notifyNGOsOfNewDonation, notifyVolunteersOfNewPickup } = require('../utils/notify');
const { predictArrivalTime } = require('../utils/geminiAI');

// @desc    Create a donation (Donor only)
// @route   POST /api/donations
// @access  Private (donor)
// @desc    Create a donation (Donor only)
// @route   POST /api/donations
// @access  Private (donor)
const createDonation = asyncHandler(async (req, res) => {
  const { foodName, category, quantity, description, expiryDate, pickupLocation } = req.body;

  const parsedLocation =
    typeof pickupLocation === 'string' ? JSON.parse(pickupLocation) : pickupLocation;
  const parsedQuantity = typeof quantity === 'string' ? JSON.parse(quantity) : quantity;

  // Duplicate/suspicious detection: compare against this donor's last 24h donations
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentDonorDonations = await Donation.find({ donor: req.user._id, createdAt: { $gte: since } });

  const flags = detectDuplicateOrSuspicious(
    { foodName, quantity: parsedQuantity, pickupLocation: parsedLocation },
    recentDonorDonations
  );

  const donation = await Donation.create({
    donor: req.user._id,
    foodName,
    category,
    quantity: parsedQuantity,
    description,
    expiryDate,
    pickupLocation: parsedLocation,
    image: req.file ? `/uploads/${req.file.filename}` : '',
    flags,
    timeline: [{ status: 'pending', note: 'Donation created', updatedBy: req.user._id }],
  });

  // Alert nearby approved NGOs by email/SMS and return notification confirmation status
  const [notificationStatus, volunteerNotifStatus] = await Promise.all([
    alertNearbyNGOs(donation).catch((err) => {
      console.error('[createDonation] Failed to alert nearby NGOs:', err.message);
      return { notifiedCount: 0, smsSent: false, recipients: [], error: err.message };
    }),
    alertNearbyVolunteers(donation).catch((err) => {
      console.error('[createDonation] Failed to alert nearby volunteers:', err.message);
      return { volunteerCount: 0 };
    }),
  ]);

  res.status(201).json({
    success: true,
    data: donation,
    notificationStatus: {
      ...(notificationStatus || { notifiedCount: 0, smsSent: false, recipients: [] }),
      volunteerCount: volunteerNotifStatus?.volunteerCount || 0,
    },
  });
});

/**
 * Smart expiry-aware NGO alert:
 * - Uses each NGO's permanent officeLocation (from NGO doc) for distance calc.
 * - Dynamically widens alert radius based on food urgency.
 * - Returns notification status so donor receives confirmation popup.
 */
async function alertNearbyNGOs(donation) {
  const { haversineDistanceKm } = require('../utils/smartFeatures');

  // Load all active NGOs with their user info
  const allNGOs = await NGO.find({ isApproved: true }).populate(
    'user',
    'name email phone location isActive'
  );

  const donationCoords = donation.pickupLocation.coordinates; // [lng, lat]
  const hoursToExpiry = Math.max(0, (new Date(donation.expiryDate) - Date.now()) / (1000 * 60 * 60));

  // Determine urgency multiplier
  let urgencyLabel = '';
  if (hoursToExpiry < 2) {
    urgencyLabel = '🚨 URGENT — expires in < 2 hrs!';
  } else if (hoursToExpiry < 6) {
    urgencyLabel = '⚠️ High priority — expires in < 6 hrs';
  }

  // Filter out any invalid / missing coordinates
  const activeMappedNGOs = allNGOs.filter(n =>
    n.user &&
    n.user.isActive &&
    n.officeLocation &&
    n.officeLocation.coordinates &&
    n.officeLocation.coordinates.length === 2 &&
    (n.officeLocation.coordinates[0] !== 0 || n.officeLocation.coordinates[1] !== 0)
  );

  // Call getEligibleNGOs() with 65km boundary (donation area <-> NGO area only)
  const eligible = getEligibleNGOs(donationCoords, donation.expiryDate, activeMappedNGOs, 65);

  if (!eligible.length) {
    return {
      notifiedCount: 0,
      noNgoReachable: false,
      message: "No registered NGO currently found within 65km of donation area."
    };
  }

  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const donationUrl = `${appUrl}/donations/${donation._id}`;
  const expiryHrsText =
    hoursToExpiry < 1
      ? `${Math.round(hoursToExpiry * 60)} minutes`
      : `${hoursToExpiry.toFixed(1)} hours`;

  const recipients = eligible.map(({ ngo }) => {
    const distanceKm = Number(haversineDistanceKm(donationCoords, ngo.officeLocation.coordinates).toFixed(2));
    return {
      name: ngo.organizationName,
      email: ngo.user.email,
      phone: ngo.user.phone,
      distanceKm,
    };
  });

  const notificationResults = await notifyNGOsOfNewDonation(recipients, {
    foodName: donation.foodName,
    quantity: donation.quantity,
    expiryDate: donation.expiryDate,
    pickupLocation: donation.pickupLocation,
    donationId: donation._id.toString(),
    urgencyLabel,
    expiryHrsText,
  });

  const smsSent = notificationResults.some((r) => r.sms && r.sms.sent);
  const notifiedCount = recipients.length;

  console.log(
    `[alertNearbyNGOs] Alerted ${notifiedCount} NGO(s) for donation "${
      donation.foodName
    }" (SMS sent: ${smsSent})`
  );

  return {
    notifiedCount,
    smsSent,
    recipients,
    results: notificationResults,
  };
}

/**
 * Find volunteers currently tracking (trackingEnabled=true) within radiusKm
 * of the donation pickup location. These volunteers will discover the donation
 * on their next poll of GET /api/volunteer/nearby-donations.
 * Returns count of nearby volunteers found.
 */
async function alertNearbyVolunteers(donation) {
  const Volunteer = require('../models/Volunteer');

  const donCoords = donation.pickupLocation?.coordinates; // [lng, lat]
  if (!donCoords) return { volunteerCount: 0 };

  const hoursToExpiry = Math.max(0, (new Date(donation.expiryDate) - Date.now()) / (1000 * 60 * 60));
  // Widen radius if urgent
  const radiusKm = hoursToExpiry < 2 ? 10 : hoursToExpiry < 6 ? 7 : 5;

  // Fetch tracking volunteers with their user location
  const trackingVolunteers = await Volunteer.find({ trackingEnabled: true, isApproved: true }).populate(
    'user',
    'name phone location isActive'
  );

  const nearby = trackingVolunteers.filter((v) => {
    if (!v.user || !v.user.isActive) return false;
    const vCoords = v.user?.location?.coordinates;
    if (!vCoords || (Math.abs(vCoords[0]) < 0.0001 && Math.abs(vCoords[1]) < 0.0001)) return false;
    const { haversineDistanceKm } = require('../utils/smartFeatures');
    return haversineDistanceKm(donCoords, vCoords) <= radiusKm;
  });

  console.log(
    `[alertNearbyVolunteers] ${nearby.length} volunteer(s) within ${radiusKm}km of "${donation.foodName}" — they will see it on next poll`
  );

  return { volunteerCount: nearby.length };
}

// @desc    Get donations (filtered by role, query params for search/filter)
// @route   GET /api/donations
// @access  Private
const getDonations = asyncHandler(async (req, res) => {
  const { status, category, search, near, radiusKm, sortByExpiry } = req.query;
  const filter = {};

  // Role-based visibility
  if (req.user.role === 'donor') {
    filter.donor = req.user._id;
  } else if (req.user.role === 'volunteer') {
    filter.assignedVolunteer = req.user._id;
  }
  // NGOs and Admin see broader lists, refined by query params below

  if (status) filter.status = status;
  if (category) filter.category = category;
  if (search) filter.$text = { $search: search };

  if (near) {
    const [lng, lat] = near.split(',').map(Number);
    filter.pickupLocation = {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: (Number(radiusKm) || 15) * 1000,
      },
    };
  }

  let query = Donation.find(filter)
    .populate('donor', 'name phone address avatar')
    .populate('acceptedBy', 'name phone')
    .populate('assignedVolunteer', 'name phone');

  let donations = await query.exec();

  if (sortByExpiry === 'true') {
    donations = sortByPriority(donations);
  } else {
    donations = donations.sort((a, b) => b.createdAt - a.createdAt);
  }

  res.json({ success: true, count: donations.length, data: donations });
});

// @desc    Get single donation
// @route   GET /api/donations/:id
// @access  Private
const getDonationById = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate('donor', 'name phone address avatar')
    .populate('acceptedBy', 'name phone')
    .populate('assignedVolunteer', 'name phone');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }
  res.json({ success: true, data: donation });
});

// @desc    Update donation (Donor: own pending donations only)
// @route   PUT /api/donations/:id
// @access  Private (donor)
const updateDonation = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }
  if (donation.donor.toString() !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Not authorized to edit this donation');
  }
  if (donation.status !== 'pending') {
    res.status(400);
    throw new Error('Only pending donations can be edited');
  }

  const editable = ['foodName', 'category', 'description', 'expiryDate'];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) donation[field] = req.body[field];
  });
  if (req.body.quantity) {
    donation.quantity = typeof req.body.quantity === 'string' ? JSON.parse(req.body.quantity) : req.body.quantity;
  }
  if (req.body.pickupLocation) {
    donation.pickupLocation =
      typeof req.body.pickupLocation === 'string' ? JSON.parse(req.body.pickupLocation) : req.body.pickupLocation;
  }
  if (req.file) donation.image = `/uploads/${req.file.filename}`;

  await donation.save();
  res.json({ success: true, data: donation });
});

// @desc    Delete donation (Donor: own pending donations only; Admin: any)
// @desc    Delete donation (Donor, NGO, Admin can delete any donation record)
// @route   DELETE /api/donations/:id
// @access  Private (donor, ngo, admin)
const deleteDonation = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  await donation.deleteOne();
  res.json({ success: true, message: 'Donation record deleted successfully' });
});

// @desc    Get nearest NGO recommendations for a donation
// @route   GET /api/donations/:id/nearby-ngos
// @access  Private (donor, admin)
const getNearbyNGOs = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const approvedNGOs = await NGO.find().populate('user', 'name location phone address isActive');
  const ngoList = approvedNGOs
    .filter((n) => n.user && n.user.isActive)
    .map((n) => ({
      ngoProfileId: n._id,
      organizationName: n.organizationName,
      serviceRadiusKm: n.serviceRadiusKm,
      location: n.user.location,
      user: n.user,
    }));

  const recommendations = recommendNearestNGOs(donation.pickupLocation.coordinates, ngoList, 5);
  res.json({ success: true, data: recommendations });
});

// @desc    NGO accepts a donation — ATOMIC first-accept lock with 50 km radius guard
// @route   PUT /api/donations/:id/accept
// @access  Private (ngo)
const acceptDonation = asyncHandler(async (req, res) => {
  const { haversineDistanceKm } = require('../utils/smartFeatures');

  // ── Pre-check: load donation to validate radius BEFORE the atomic update ──
  const donationCheck = await Donation.findById(req.params.id);
  if (!donationCheck) {
    res.status(404);
    throw new Error('Donation not found');
  }
  if (donationCheck.status !== 'pending') {
    res.status(400);
    throw new Error('This donation is no longer available — another NGO may have accepted it first.');
  }

  // ── 50 km radius check ────────────────────────────────────────────────────
  // Compare NGO's registered office location against the donation pickup location.
  const ngoProfile = await NGO.findOne({ user: req.user._id });
  if (ngoProfile) {
    const ngoCoords = ngoProfile.officeLocation?.coordinates;
    const pickupCoords = donationCheck.pickupLocation?.coordinates;

    // Only enforce if both coordinates are set (not [0,0])
    const hasNgoCoords = ngoCoords && (ngoCoords[0] !== 0 || ngoCoords[1] !== 0);
    const hasPickupCoords = pickupCoords && (pickupCoords[0] !== 0 || pickupCoords[1] !== 0);

    if (hasNgoCoords && hasPickupCoords) {
      const distKm = haversineDistanceKm(ngoCoords, pickupCoords);
      if (distKm > 65) {
        res.status(403);
        throw new Error(
          `This donation is ${distKm.toFixed(1)} km away from your NGO office. You can only accept donations within 65 km radius.`
        );
      }
    }
  }

  // ── Atomic first-accept-wins update ──────────────────────────────────────
  // Re-check status atomically to prevent race conditions after our pre-check.
  const donation = await Donation.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' }, // atomic guard
    {
      $set: { status: 'accepted', acceptedBy: req.user._id },
      $push: {
        timeline: {
          status: 'accepted',
          note: 'Accepted by NGO — volunteer assignment pending',
          updatedBy: req.user._id,
          timestamp: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!donation) {
    res.status(400);
    throw new Error('This donation is no longer available — another NGO may have accepted it first.');
  }

  await NGO.findOneAndUpdate({ user: req.user._id }, { $inc: { totalDonationsAccepted: 1 } });

  res.json({ success: true, data: donation });
});

// @desc    NGO rejects a donation
// @route   PUT /api/donations/:id/reject
// @access  Private (ngo)
const rejectDonation = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }
  donation.status = 'rejected';
  donation.timeline.push({ status: 'rejected', note: req.body.reason || 'Rejected by NGO', updatedBy: req.user._id });
  await donation.save();
  res.json({ success: true, data: donation });
});

// @desc    NGO assigns/alerts volunteers to an accepted donation
// @route   PUT /api/donations/:id/assign-volunteer
// @access  Private (ngo)
const assignVolunteer = asyncHandler(async (req, res) => {
  const { volunteerId } = req.body;

  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  // ── Flow enforcement ────────────────────────────────────────────────────
  if (donation.status !== 'accepted') {
    res.status(400);
    throw new Error(
      donation.status === 'pending'
        ? 'Cannot assign a volunteer yet — the donation is still pending NGO acceptance.'
        : `Cannot assign a volunteer to a donation with status "${donation.status}".`
    );
  }

  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the accepting NGO can assign a volunteer');
  }

  const ngo = await NGO.findOne({ user: req.user._id });
  const Volunteer = require('../models/Volunteer');

  // ── If NGO selected a specific volunteer from dropdown ─────────────────
  if (volunteerId) {
    const targetVolunteerUser = await User.findById(volunteerId);
    if (!targetVolunteerUser) {
      res.status(404);
      throw new Error('Selected volunteer not found');
    }

    donation.assignedVolunteer = targetVolunteerUser._id;
    donation.status = 'assigned_pending_volunteer';
    donation.volunteerInvitationStatus = 'pending';
    const now = new Date();
    donation.assignedAt = now;
    donation.volunteerNotifiedAt = now;
    donation.responseDeadline = new Date(now.getTime() + 7 * 60 * 1000);

    donation.timeline.push({
      status: 'assigned_pending_volunteer',
      note: `NGO assigned volunteer ${targetVolunteerUser.name}. Awaiting volunteer acceptance (7 min timeout).`,
      updatedBy: req.user._id,
      timestamp: now,
    });

    await donation.save();

    // Notify assigned volunteer via email + SMS to ACCEPT or DECLINE
    const { sendEmail, sendSMS } = require('../utils/notify');
    const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const donationUrl = `${appUrl}/dashboard/pickups`;

    const subject = `🚲 Pickup Invitation from ${ngo?.organizationName || 'NGO'}: ${donation.foodName}`;
    const textBody = `Hi ${targetVolunteerUser.name},\n\nNGO "${ngo?.organizationName || 'NGO'}" has invited you to pick up food donation "${donation.foodName}".\n\nPickup Address: ${donation.pickupLocation?.address}\n\nPlease log in to your dashboard to ACCEPT or DECLINE this request:\n${donationUrl}\n\n— GiveAway Platform`;
    const htmlBody = `
      <div style="font-family:sans-serif;max-width:500px">
        <h2 style="color:#16a34a">🚲 Pickup Invitation!</h2>
        <p>Hi <strong>${targetVolunteerUser.name}</strong>,</p>
        <p>NGO <strong>${ngo?.organizationName || 'NGO'}</strong> has invited you to pick up food donation <strong>${donation.foodName}</strong>.</p>
        <p><strong>Pickup Address:</strong> ${donation.pickupLocation?.address}</p>
        <p>Please log in to your dashboard to <strong>ACCEPT</strong> or <strong>DECLINE</strong> this request.</p>
        <a href="${donationUrl}" style="display:inline-block;background:#16a34a;color:white;padding:10px 18px;border-radius:8px;text-decoration:none">Open Dashboard</a>
      </div>`;
    const smsMsg = `GiveAway 🚲 NGO "${ngo?.organizationName || 'NGO'}" invited you to pick up "${donation.foodName}". Please check your dashboard to ACCEPT or DECLINE. ${donationUrl}`;

    Promise.all([
      targetVolunteerUser.email ? sendEmail({ to: targetVolunteerUser.email, subject, text: textBody, html: htmlBody }).catch(() => {}) : Promise.resolve(),
      targetVolunteerUser.phone ? sendSMS({ to: targetVolunteerUser.phone, message: smsMsg }).catch(() => {}) : Promise.resolve(),
    ]).catch(() => {});

    return res.json({
      success: true,
      message: `Invitation sent to volunteer ${targetVolunteerUser.name}! Awaiting volunteer acceptance.`,
      data: donation,
    });
  }

  // ── Fallback: Broadcast to nearby tracking volunteers ───────────────────
  const trackingVolunteers = await Volunteer.find({ trackingEnabled: true, isApproved: true }).populate('user');
  const activeUserIds = trackingVolunteers.map(v => v.user?._id).filter(Boolean);
  const allVolunteers = await User.find({ _id: { $in: activeUserIds }, isActive: true });

  const donorCoords = donation.pickupLocation.coordinates;
  const ngoCoords = ngo?.officeLocation?.coordinates || req.user.location?.coordinates || [0,0];

  const eligibleVolunteers = getEligibleVolunteers(donorCoords, ngoCoords, allVolunteers, 65);

  const recipients = eligibleVolunteers.map(v => ({
    name: v.name,
    email: v.email,
    phone: v.phone
  }));

  if (recipients.length > 0) {
    await notifyVolunteersOfNewPickup(recipients, {
      foodName: donation.foodName,
      quantity: donation.quantity,
      expiryDate: donation.expiryDate,
      pickupLocation: donation.pickupLocation,
      donationId: donation._id.toString()
    }).catch(err => console.error('[assignVolunteer] Failed to notify volunteers:', err));
  }

  donation.notifiedVolunteers = eligibleVolunteers.map(v => v._id);
  donation.volunteerNotifiedAt = new Date();
  donation.assignedVolunteer = null;
  donation.status = 'out_for_pickup';
  donation.timeline.push({
    status: 'out_for_pickup',
    note: `Alerted ${eligibleVolunteers.length} eligible volunteer(s) within 65km for pickup`,
    updatedBy: req.user._id
  });
  await donation.save();

  res.json({ success: true, data: donation });
});

// @desc    Volunteer updates pickup/delivery status
// @route   PUT /api/donations/:id/status
// @access  Private (volunteer)
const updateDeliveryStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['picked_up', 'delivered'];
  if (!allowed.includes(status)) {
    res.status(400);
    throw new Error(`Status must be one of: ${allowed.join(', ')}`);
  }

  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }
  const isAssignedVolunteer = donation.assignedVolunteer &&
    donation.assignedVolunteer.toString() === req.user._id.toString();
  const isSelfPickupNGO = donation.isSelfPickup && donation.acceptedBy &&
    donation.acceptedBy.toString() === req.user._id.toString();

  if (!isAssignedVolunteer && !isSelfPickupNGO) {
    res.status(403);
    throw new Error('You are not assigned to this donation');
  }

  if (status === 'delivered') {
    donation.status = 'delivery_pending_ngo_confirmation';
    donation.volunteerDelivered = true;
    donation.timeline.push({
      status: 'delivery_pending_ngo_confirmation',
      note: note || `Volunteer ${req.user.name || ''} marked food as delivered. Awaiting NGO confirmation.`,
      updatedBy: req.user._id,
      timestamp: new Date(),
    });
    await donation.save();

    // Notify receiving NGO via Email & SMS to confirm receipt
    const { sendEmail, sendSMS } = require('../utils/notify');
    const ngoUser = await User.findById(donation.acceptedBy);

    if (ngoUser) {
      const subject = `📦 Food Delivered by Volunteer — Action Required: Confirm Receipt`;
      const textBody = `Hi ${ngoUser.name},\n\nVolunteer ${req.user.name || 'Volunteer'} has delivered the food donation "${donation.foodName}" to your location!\n\nPlease log in to your NGO dashboard and click "Confirm Food Received" to complete this order.\n\n— GiveAway Platform`;
      const htmlBody = `
        <div style="font-family:sans-serif;max-width:500px">
          <h2 style="color:#16a34a">📦 Food Delivered! Confirm Receipt Required</h2>
          <p>Volunteer <strong>${req.user.name || 'Volunteer'}</strong> has arrived and marked delivery complete for <strong>${donation.foodName}</strong>.</p>
          <p>Please log in to your NGO dashboard and click <strong>Confirm Food Received</strong> to complete the order.</p>
        </div>`;
      const smsMsg = `GiveAway 📦 Volunteer ${req.user.name || 'Volunteer'} delivered "${donation.foodName}" to your NGO! Please log in to your NGO dashboard to confirm receipt.`;

      Promise.all([
        ngoUser.email ? sendEmail({ to: ngoUser.email, subject, text: textBody, html: htmlBody }).catch(() => {}) : Promise.resolve(),
        ngoUser.phone ? sendSMS({ to: ngoUser.phone, message: smsMsg }).catch(() => {}) : Promise.resolve(),
      ]).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Delivery marked complete! Awaiting NGO confirmation.',
      data: donation,
    });
  }

  donation.status = status;
  donation.timeline.push({ status, note, updatedBy: req.user._id });
  await donation.save();

  res.json({ success: true, data: donation });
});

// @desc    Get live tracking data for a donation (volunteer position + pickup location)
// @route   GET /api/donations/:id/track
// @access  Private
const trackDonation = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate('assignedVolunteer', 'name phone location')
    .populate('acceptedBy', 'name');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const trackableStatuses = ['out_for_pickup', 'picked_up'];
  if (!trackableStatuses.includes(donation.status) || !donation.assignedVolunteer) {
    return res.json({
      success: true,
      data: {
        trackingAvailable: false,
        reason:
          donation.status === 'accepted'
            ? 'Volunteer not yet assigned.'
            : `Tracking not available for status: ${donation.status}.`,
      },
    });
  }

  const volunteerUser = donation.assignedVolunteer;
  const liveLocation = volunteerUser.location?.coordinates || null;
  const lastUpdated = volunteerUser.updatedAt || null;

  // Mark as stale if no update in the last 2 minutes
  const isStale = lastUpdated && Date.now() - new Date(lastUpdated).getTime() > 2 * 60 * 1000;

  // Calculate Gemini AI arrival prediction based on distance
  const { haversineDistanceKm } = require('../utils/smartFeatures');
  const distKm = liveLocation && donation.pickupLocation?.coordinates
    ? haversineDistanceKm(liveLocation, donation.pickupLocation.coordinates)
    : 0;

  const etaPrediction = await predictArrivalTime({
    originCoords: liveLocation,
    destinationCoords: donation.pickupLocation?.coordinates,
    distanceKm: distKm,
    foodCategory: donation.category,
    destinationAddress: donation.pickupLocation?.address,
  });

  res.json({
    success: true,
    data: {
      trackingAvailable: true,
      volunteer: { name: volunteerUser.name, phone: volunteerUser.phone },
      liveLocation,        // [lng, lat] from volunteer's device
      pickupLocation: donation.pickupLocation,
      status: donation.status,
      lastUpdated,
      isStale,
      etaPrediction,
    },
  });
});

// @desc    Predict arrival time (ETA) using Gemini AI
// @route   POST /api/donations/:id/predict-eta
// @access  Private
const predictDonationETA = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate('donor', 'name address location')
    .populate('acceptedBy', 'name officeLocation officeAddress')
    .populate('assignedVolunteer', 'name location');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const { vehicleType } = req.body; // e.g. bike, car, van, on_foot

  let originCoords = donation.pickupLocation?.coordinates;
  let destinationCoords = null;
  let originAddress = donation.pickupLocation?.address || '';
  let destinationAddress = '';

  if (donation.acceptedBy) {
    destinationCoords = donation.acceptedBy.officeLocation?.coordinates || donation.acceptedBy.location?.coordinates;
    destinationAddress = donation.acceptedBy.officeAddress || donation.acceptedBy.address || '';
  }

  const { haversineDistanceKm } = require('../utils/smartFeatures');
  const distanceKm = originCoords && destinationCoords ? haversineDistanceKm(originCoords, destinationCoords) : 5;

  const etaPrediction = await predictArrivalTime({
    originCoords,
    destinationCoords,
    distanceKm,
    vehicleType: vehicleType || 'bike',
    foodCategory: donation.category,
    originAddress,
    destinationAddress,
  });

  res.json({
    success: true,
    data: {
      donationId: donation._id,
      foodName: donation.foodName,
      prediction: etaPrediction,
    },
  });
});

// @desc    Get live tracking data for a volunteer based on their phone number
// @route   GET /api/donations/track-by-phone/:phone
// @access  Private
const trackVolunteerByPhone = asyncHandler(async (req, res) => {
  const rawPhone = (req.params.phone || '').trim();
  if (!rawPhone) {
    res.status(400);
    throw new Error('Phone number is required');
  }

  const cleanDigits = rawPhone.replace(/\D/g, '').slice(-10);

  const volunteerUser = await User.findOne({
    role: 'volunteer',
    $or: [
      { phone: rawPhone },
      { phone: `+91${cleanDigits}` },
      { phone: cleanDigits },
    ],
  });

  if (!volunteerUser) {
    res.status(404);
    throw new Error(`No registered volunteer found with phone number "${rawPhone}".`);
  }

  // Find active assigned pickup/delivery donations for this volunteer
  const activePickups = await Donation.find({
    assignedVolunteer: volunteerUser._id,
    status: { $in: ['out_for_pickup', 'picked_up'] },
  }).populate('donor', 'name phone address').populate('acceptedBy', 'name phone');

  const liveLocation = volunteerUser.location?.coordinates || null;
  const lastUpdated = volunteerUser.updatedAt || null;
  const isStale = lastUpdated && Date.now() - new Date(lastUpdated).getTime() > 2 * 60 * 1000;

  res.json({
    success: true,
    data: {
      volunteer: {
        _id: volunteerUser._id,
        name: volunteerUser.name,
        phone: volunteerUser.phone,
        email: volunteerUser.email,
        address: volunteerUser.address,
      },
      liveLocation,
      lastUpdated,
      isStale,
      activePickups,
    },
  });
});

// @desc    NGO decides on self-pickup when no volunteer was found
// @route   PUT /api/donations/:id/self-pickup
// @access  Private (ngo)
const ngoSelfPickupDecision = asyncHandler(async (req, res) => {
  const { accepted } = req.body;
  const donation = await Donation.findById(req.params.id);
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  if (donation.status !== 'awaiting_ngo_selfpickup') {
    res.status(400);
    throw new Error('This donation is not awaiting a self-pickup decision');
  }

  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the accepting NGO can make this decision');
  }

  if (accepted === true) {
    donation.status = 'out_for_pickup';
    donation.isSelfPickup = true;
    // Do NOT set assignedVolunteer — the NGO is handling pickup themselves,
    // and assignedVolunteer must stay reserved for actual volunteer users
    // (per updateDeliveryStatus's authorize('volunteer') restriction below).
    donation.timeline.push({
      status: 'out_for_pickup',
      note: 'NGO decided to self-collect the food donation',
      updatedBy: req.user._id,
      timestamp: new Date()
    });
  } else {
    donation.status = 'cancelled';
    donation.timeline.push({
      status: 'cancelled',
      note: 'NGO declined self-collection; donation cancelled',
      updatedBy: req.user._id,
      timestamp: new Date()
    });
  }

  await donation.save();
  res.json({ success: true, data: donation });
});

/**
 * @desc  Volunteer submits food safety review at pickup location
 * @route PUT /api/donations/:id/food-review
 * @access Private (volunteer)
 */
const foodSafetyReview = asyncHandler(async (req, res) => {
  const { isSafe } = req.body;

  if (typeof isSafe !== 'boolean') {
    res.status(400);
    throw new Error('isSafe must be a boolean value');
  }

  // Populate acceptedBy (User) to get name, email, phone
  // Also populate donor for completeness
  const donation = await Donation.findById(req.params.id)
    .populate('acceptedBy', 'name email phone')
    .populate('donor', 'name email phone');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  // Only the assigned volunteer can submit a review
  const volUserId = (donation.assignedVolunteer?._id || donation.assignedVolunteer)?.toString();
  if (!volUserId || volUserId !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the assigned volunteer can submit a food safety review');
  }

  if (donation.status !== 'out_for_pickup') {
    res.status(400);
    throw new Error('Food safety review can only be submitted when status is out_for_pickup');
  }

  // ── Fetch actual ESP32 food quality score belonging to this donation ──────
  const FoodTest = require('../models/FoodTest');
  let latestTest = await FoodTest.findOne(
    { donationId: donation._id, status: 'completed', foodQualityScore: { $ne: null } },
    null,
    { sort: { completedAt: -1 } }
  );

  // If no completed test found, check if an active test has readings and complete it
  if (!latestTest) {
    const activeTest = await FoodTest.findOne(
      { donationId: donation._id, status: 'active' },
      null,
      { sort: { startedAt: -1 } }
    );
    if (activeTest && activeTest.readings && activeTest.readings.length > 0) {
      const { calculateFoodQualityScore } = require('../utils/foodQualityScorer');
      const scoreResult = calculateFoodQualityScore(activeTest.readings);
      activeTest.status = 'completed';
      activeTest.completedAt = new Date();
      activeTest.foodQualityScore = scoreResult ? scoreResult.foodQualityScore : null;
      await activeTest.save();
      latestTest = activeTest;
    }
  }

  if (!latestTest || latestTest.foodQualityScore == null) {
    res.status(400);
    throw new Error('Food Health Score is not available for this donation. ESP32 test must be completed first.');
  }

  const actualScore = latestTest.foodQualityScore;
  const isScoreSafe = actualScore >= 50;

  // ── Backend Review Validation ─────────────────────────────────────────────
  // Exactly >= 50% is SAFE, < 50% is UNSAFE
  if (isSafe !== isScoreSafe) {
    res.status(400);
    throw new Error('Review does not match the ESP32 food health analysis.');
  }

  // ── Save review result and actual ESP32 health score ──────────────────────
  donation.foodSafetyReview = {
    review: isSafe ? 'SAFE' : 'UNSAFE',
    healthScore: actualScore,
    reviewedAt: new Date(),
  };

  const { sendEmail, sendSMS } = require('../utils/notify');

  // ── Fetch NGO profile separately to get officeLocation for ETA ──────────
  // acceptedBy is the User doc; NGO profile is separate (NGO.user = acceptedBy._id)
  let ngoOfficeCoords = null;
  let ngoPhone = donation.acceptedBy?.phone || null;

  try {
    if (donation.acceptedBy?._id) {
      const ngoDoc = await NGO.findOne({ user: donation.acceptedBy._id });
      if (ngoDoc) {
        const coords = ngoDoc.officeLocation?.coordinates;
        if (coords && (coords[0] !== 0 || coords[1] !== 0)) {
          ngoOfficeCoords = coords;
        }
      }
    }
  } catch (ngoErr) {
    console.warn('[foodSafetyReview] Could not fetch NGO profile:', ngoErr.message);
  }

  if (isSafe) {
    // ── Food is SAFE → mark as picked_up and notify NGO ─────────────────
    donation.status = 'picked_up';
    donation.timeline.push({
      status: 'picked_up',
      note: `Volunteer confirmed food is safe (ESP32 Health Score: ${actualScore}%). En route to NGO.`,
      updatedBy: req.user._id,
      timestamp: new Date(),
    });

    await donation.save();

    // ── Get ETA using volunteer's live GPS → NGO office ──────────────────
    let etaText = 'shortly';
    try {
      const volunteerCoords = req.user.location?.coordinates; // [lng, lat]
      const destCoords = ngoOfficeCoords || donation.pickupLocation?.coordinates;

      if (volunteerCoords && destCoords &&
          (volunteerCoords[0] !== 0 || volunteerCoords[1] !== 0)) {
        const etaResult = await predictArrivalTime({
          volunteerCoords,
          destinationCoords: destCoords,
          vehicleType: req.user.vehicleType || 'bike',
        });
        etaText = etaResult?.formattedEta || etaText;
      }
    } catch (etaErr) {
      console.warn('[foodSafetyReview] ETA fetch failed:', etaErr.message);
    }

    // ── Notify NGO via email + SMS ────────────────────────────────────────
    const ngo = donation.acceptedBy;
    if (ngo) {
      const subject = '✅ Food Safety Confirmed — Volunteer On the Way!';
      const textBody = [
        `Great news! 🎉`,
        ``,
        `Volunteer ${req.user.name} has inspected and confirmed that the food donation`,
        `"${donation.foodName}" is SAFE for consumption.`,
        ``,
        `📦 Food: ${donation.foodName}`,
        `🚴 Volunteer: ${req.user.name}`,
        `🛡️ Food Safety Review: SAFE`,
        `📊 Food Health Score: ${actualScore}%`,
        `⏱️ Estimated Arrival: ${etaText}`,
        ``,
        `Please be ready to receive the delivery at your NGO.`,
        ``,
        `— GiveAway Platform`,
      ].join('\n');

      const htmlBody = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <div style="background:#16a34a;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:#fff;margin:0">✅ Food is Safe — Volunteer En Route!</h2>
          </div>
          <div style="border:1px solid #d1fae5;border-top:none;padding:24px;border-radius:0 0 12px 12px;background:#f0fdf4">
            <p style="margin:0 0 12px">Volunteer <strong>${req.user.name}</strong> has inspected and confirmed the food donation is <strong style="color:#16a34a">SAFE</strong> based on ESP32 food health analysis.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:6px 0;color:#6b7280">📦 Food:</td><td style="padding:6px 0;font-weight:600">${donation.foodName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">🚴 Volunteer:</td><td style="padding:6px 0;font-weight:600">${req.user.name}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">🛡️ Safety Review:</td><td style="padding:6px 0;font-weight:600;color:#16a34a">SAFE</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">📊 Food Health Score:</td><td style="padding:6px 0;font-weight:600;color:#2563eb">${actualScore}%</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">⏱️ ETA:</td><td style="padding:6px 0;font-weight:600;color:#16a34a">${etaText}</td></tr>
            </table>
            <p style="margin:0;color:#374151">Please be ready to receive the delivery at your NGO.</p>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:12px">— GiveAway Platform</p>
        </div>`;

      const smsMessage = `GiveAway ✅ Food Safety Review: SAFE. Food Health Score: ${actualScore}%. Volunteer ${req.user.name} confirmed "${donation.foodName}" is safe & is on the way to your NGO. ETA: ${etaText}. Please be ready!`;

      console.log(`[foodSafetyReview] Notifying NGO ${ngo.email} (phone: ${ngoPhone || 'not set'}) — Food Safety Review: SAFE, Food Health Score: ${actualScore}%`);

      await Promise.all([
        sendEmail({ to: ngo.email, subject, text: textBody, html: htmlBody }).catch((e) => {
          console.warn('[foodSafetyReview] Email send failed:', e.message);
        }),
        ngoPhone
          ? sendSMS({ to: ngoPhone, message: smsMessage }).catch((e) => {
              console.warn('[foodSafetyReview] SMS send failed:', e.message);
            })
          : Promise.resolve(console.log('[foodSafetyReview] SMS skipped — NGO has no phone on record')),
      ]);
    }

    res.json({
      success: true,
      message: `✅ Food confirmed safe! NGO has been notified via email${ngoPhone ? ' & SMS' : ''}. Health Score: ${actualScore}%. ETA: ${etaText}`,
      eta: etaText,
      healthScore: actualScore,
      data: donation,
    });

  } else {
    // ── Food is UNSAFE → cancel and notify NGO ───────────────────────────
    donation.status = 'expired';
    donation.timeline.push({
      status: 'expired',
      note: `Volunteer reported food as unsafe (ESP32 Health Score: ${actualScore}%). Delivery cancelled.`,
      updatedBy: req.user._id,
      timestamp: new Date(),
    });

    await donation.save();

    // ── Notify NGO via email + SMS ────────────────────────────────────────
    const ngo = donation.acceptedBy;
    if (ngo) {
      const subject = '❌ Food Found Unsafe at Pickup — Delivery Cancelled';
      const textBody = [
        `We're sorry to inform you.`,
        ``,
        `Volunteer ${req.user.name} reported that the food donation "${donation.foodName}"`,
        `is UNSAFE upon arrival at the pickup location.`,
        ``,
        `📦 Food: ${donation.foodName}`,
        `🚴 Volunteer: ${req.user.name}`,
        `🛡️ Food Safety Review: UNSAFE`,
        `📊 Food Health Score: ${actualScore}%`,
        `❌ Status: Delivery Cancelled (food safety)`,
        ``,
        `The delivery has been automatically cancelled to protect recipient safety.`,
        `We sincerely apologize for the inconvenience.`,
        ``,
        `— GiveAway Platform`,
      ].join('\n');

      const htmlBody = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <div style="background:#dc2626;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:#fff;margin:0">❌ Food Found Unsafe — Delivery Cancelled</h2>
          </div>
          <div style="border:1px solid #fecaca;border-top:none;padding:24px;border-radius:0 0 12px 12px;background:#fff5f5">
            <p style="margin:0 0 12px">Unfortunately, Volunteer <strong>${req.user.name}</strong> reported that the food was <strong style="color:#dc2626">UNSAFE</strong> at the pickup location based on ESP32 health analysis.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:6px 0;color:#6b7280">📦 Food:</td><td style="padding:6px 0;font-weight:600">${donation.foodName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">🚴 Volunteer:</td><td style="padding:6px 0;font-weight:600">${req.user.name}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">🛡️ Safety Review:</td><td style="padding:6px 0;font-weight:600;color:#dc2626">UNSAFE</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">📊 Food Health Score:</td><td style="padding:6px 0;font-weight:600;color:#dc2626">${actualScore}%</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">❌ Action:</td><td style="padding:6px 0;font-weight:600;color:#dc2626">Delivery Cancelled</td></tr>
            </table>
            <p style="margin:0;color:#374151">The delivery has been automatically cancelled to protect recipient safety. We sincerely apologize.</p>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:12px">— GiveAway Platform</p>
        </div>`;

      const smsMessage = `GiveAway ❌ Food Safety Review: UNSAFE. Food Health Score: ${actualScore}%. Volunteer ${req.user.name} reported "${donation.foodName}" is unsafe at pickup location. Delivery CANCELLED.`;

      console.log(`[foodSafetyReview] Notifying NGO ${ngo.email} (phone: ${ngoPhone || 'not set'}) — Food Safety Review: UNSAFE, Food Health Score: ${actualScore}%`);

      await Promise.all([
        sendEmail({ to: ngo.email, subject, text: textBody, html: htmlBody }).catch((e) => {
          console.warn('[foodSafetyReview] Email send failed:', e.message);
        }),
        ngoPhone
          ? sendSMS({ to: ngoPhone, message: smsMessage }).catch((e) => {
              console.warn('[foodSafetyReview] SMS send failed:', e.message);
            })
          : Promise.resolve(console.log('[foodSafetyReview] SMS skipped — NGO has no phone on record')),
      ]);
    }

    res.json({
      success: true,
      message: `❌ Food marked as unsafe. NGO has been notified via email${ngoPhone ? ' & SMS' : ''}. Health Score: ${actualScore}%. Delivery cancelled.`,
      healthScore: actualScore,
      data: donation,
    });
  }
});

/**
 * @desc  Volunteer responds (accepts or declines) an NGO pickup invitation
 * @route PUT /api/donations/:id/volunteer-response
 * @access Private (volunteer)
 */
const volunteerRespondInvitation = asyncHandler(async (req, res) => {
  const { accept } = req.body;
  if (typeof accept !== 'boolean') {
    res.status(400);
    throw new Error('accept must be a boolean value');
  }

  const donation = await Donation.findById(req.params.id).populate('acceptedBy', 'name email phone');
  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const volUserId = (donation.assignedVolunteer?._id || donation.assignedVolunteer)?.toString();
  if (!volUserId || volUserId !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the assigned volunteer can respond to this invitation');
  }

  const { sendEmail, sendSMS } = require('../utils/notify');
  const Volunteer = require('../models/Volunteer');
  const ngoUser = donation.acceptedBy;

  if (accept) {
    // ── Volunteer ACCEPTED invitation ──────────────────────────────────────
    donation.volunteerInvitationStatus = 'accepted';
    donation.status = 'out_for_pickup';
    donation.timeline.push({
      status: 'out_for_pickup',
      note: `Volunteer ${req.user.name} accepted the pickup invitation. Heading to pickup location.`,
      updatedBy: req.user._id,
      timestamp: new Date(),
    });

    await donation.save();
    await Volunteer.findOneAndUpdate({ user: req.user._id }, { availabilityStatus: 'busy' });

    // Notify NGO via Email + SMS
    if (ngoUser) {
      const subject = `✅ Volunteer Accepted Pickup: ${donation.foodName}`;
      const textBody = `Hi ${ngoUser.name},\n\nVolunteer ${req.user.name} has ACCEPTED your pickup request for "${donation.foodName}".\n\nThey are now heading to the pickup location.\n\n— GiveAway Platform`;
      const htmlBody = `<h2 style="color:#16a34a">✅ Volunteer Accepted Pickup Request</h2><p>Volunteer <strong>${req.user.name}</strong> has ACCEPTED your request to pick up <strong>${donation.foodName}</strong>.</p><p>They are en route to the pickup location.</p>`;
      const smsMsg = `GiveAway: ✅ Volunteer ${req.user.name} ACCEPTED your pickup request for "${donation.foodName}"! En route to pickup.`;

      Promise.all([
        sendEmail({ to: ngoUser.email, subject, text: textBody, html: htmlBody }).catch(() => {}),
        ngoUser.phone ? sendSMS({ to: ngoUser.phone, message: smsMsg }).catch(() => {}) : Promise.resolve(),
      ]).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Invitation accepted! Please inspect the food upon arrival at the pickup location.',
      data: donation,
    });
  } else {
    // ── Volunteer DECLINED invitation ──────────────────────────────────────
    donation.assignedVolunteer = null;
    donation.volunteerInvitationStatus = 'rejected';
    donation.status = 'accepted'; // return to NGO accepted pool
    donation.timeline.push({
      status: 'accepted',
      note: `Volunteer ${req.user.name} declined pickup invitation. Donation returned to NGO pool for reassignment.`,
      updatedBy: req.user._id,
      timestamp: new Date(),
    });

    await donation.save();

    // Notify NGO via Email + SMS
    if (ngoUser) {
      const subject = `⚠️ Volunteer Declined Pickup: ${donation.foodName}`;
      const textBody = `Hi ${ngoUser.name},\n\nVolunteer ${req.user.name} DECLINED your pickup request for "${donation.foodName}".\n\nPlease log in to your NGO dashboard to assign another volunteer.\n\n— GiveAway Platform`;
      const htmlBody = `<h2 style="color:#dc2626">⚠️ Volunteer Declined Pickup Request</h2><p>Volunteer <strong>${req.user.name}</strong> DECLINED your request for <strong>${donation.foodName}</strong>.</p><p>Please assign another volunteer from your NGO dashboard.</p>`;
      const smsMsg = `GiveAway: ⚠️ Volunteer ${req.user.name} DECLINED pickup request for "${donation.foodName}". Please assign another volunteer.`;

      Promise.all([
        sendEmail({ to: ngoUser.email, subject, text: textBody, html: htmlBody }).catch(() => {}),
        ngoUser.phone ? sendSMS({ to: ngoUser.phone, message: smsMsg }).catch(() => {}) : Promise.resolve(),
      ]).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Invitation declined. The NGO has been notified to assign another volunteer.',
      data: donation,
    });
  }
});

/**
 * @desc  Volunteer marks delivery completed upon arriving at NGO location
 * @route PUT /api/donations/:id/volunteer-complete
 * @access Private (volunteer)
 */
const volunteerCompleteDelivery = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate('acceptedBy', 'name email phone')
    .populate('donor', 'name email phone');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const volUserId = (donation.assignedVolunteer?._id || donation.assignedVolunteer)?.toString();
  if (!volUserId || volUserId !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the assigned volunteer can complete this delivery');
  }

  if (donation.status !== 'picked_up') {
    res.status(400);
    throw new Error('Delivery can only be completed after food is picked up');
  }

  donation.volunteerDelivered = true;
  donation.status = 'delivery_pending_ngo_confirmation';
  donation.timeline.push({
    status: 'delivery_pending_ngo_confirmation',
    note: `Volunteer ${req.user.name} arrived at NGO location and marked delivery complete. Awaiting NGO receipt confirmation.`,
    updatedBy: req.user._id,
    timestamp: new Date(),
  });

  await donation.save();

  // Notify NGO via Email & SMS
  const { sendEmail, sendSMS } = require('../utils/notify');
  const ngoUser = donation.acceptedBy;

  if (ngoUser) {
    const subject = `📦 Food Delivered by Volunteer — Action Required: Confirm Receipt`;
    const textBody = `Hi ${ngoUser.name},\n\nVolunteer ${req.user.name} has delivered the food donation "${donation.foodName}" to your location!\n\nPlease log in to your NGO dashboard and click "Confirm Received" to complete this order.\n\n— GiveAway Platform`;
    const htmlBody = `
      <div style="font-family:sans-serif;max-width:500px">
        <h2 style="color:#16a34a">📦 Food Delivered! Confirm Receipt Required</h2>
        <p>Volunteer <strong>${req.user.name}</strong> has arrived and marked delivery complete for <strong>${donation.foodName}</strong>.</p>
        <p>Please log in to your NGO dashboard and click <strong>Confirm Received</strong> to complete the order.</p>
      </div>`;
    const smsMsg = `GiveAway 📦 Volunteer ${req.user.name} delivered "${donation.foodName}" to your NGO! Please log in to your NGO dashboard to confirm receipt.`;

    Promise.all([
      sendEmail({ to: ngoUser.email, subject, text: textBody, html: htmlBody }).catch(() => {}),
      ngoUser.phone ? sendSMS({ to: ngoUser.phone, message: smsMsg }).catch(() => {}) : Promise.resolve(),
    ]).catch(() => {});
  }

  res.json({
    success: true,
    message: 'Delivery marked complete! NGO has been notified to confirm food receipt.',
    data: donation,
  });
});

/**
 * @desc  NGO confirms food receipt and completes all processes for donation
 * @route PUT /api/donations/:id/ngo-confirm-delivery
 * @access Private (ngo)
 */
const ngoConfirmDelivery = asyncHandler(async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate('acceptedBy', 'name email phone')
    .populate('assignedVolunteer', 'name email phone')
    .populate('donor', 'name email phone');

  if (!donation) {
    res.status(404);
    throw new Error('Donation not found');
  }

  const ngoUserId = (donation.acceptedBy?._id || donation.acceptedBy)?.toString();
  if (!ngoUserId || ngoUserId !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Only the receiving NGO can confirm delivery');
  }

  donation.status = 'delivered';
  donation.deliveredAt = new Date();
  donation.timeline.push({
    status: 'delivered',
    note: `NGO confirmed receipt of food donation. All processes completed successfully! 🎉`,
    updatedBy: req.user._id,
    timestamp: new Date(),
  });

  await donation.save();

  // Increment NGO stats & Volunteer stats
  const NGO = require('../models/NGO');
  const Volunteer = require('../models/Volunteer');
  const meals = donation.estimatedMeals || (donation.quantity?.value ? Math.round(donation.quantity.value * 3) : 10);

  await NGO.findOneAndUpdate({ user: req.user._id }, { $inc: { totalMealsDistributed: meals } });

  if (donation.assignedVolunteer?._id) {
    await Volunteer.findOneAndUpdate(
      { user: donation.assignedVolunteer._id },
      { $inc: { totalPickupsCompleted: 1 }, availabilityStatus: 'available' }
    );
  }

  // Send final completion SMS + Email to Volunteer, Donor & NGO
  const { sendEmail, sendSMS } = require('../utils/notify');
  const ngoName = req.user.name;
  const vol = donation.assignedVolunteer;
  const donor = donation.donor;

  const finalSmsMsg = `GiveAway 🎉 All done! NGO confirmed receipt of "${donation.foodName}". Thank you everyone for making this donation a success!`;

  const notifs = [];
  if (vol?.phone) notifs.push(sendSMS({ to: vol.phone, message: finalSmsMsg }));
  if (donor?.phone) notifs.push(sendSMS({ to: donor.phone, message: finalSmsMsg }));
  if (vol?.email) notifs.push(sendEmail({ to: vol.email, subject: `🎉 Order Completed: ${donation.foodName}`, text: finalSmsMsg }));
  if (donor?.email) notifs.push(sendEmail({ to: donor.email, subject: `🎉 Your donation reached recipients: ${donation.foodName}`, text: finalSmsMsg }));

  Promise.all(notifs).catch(() => {});

  res.json({
    success: true,
    message: '🎉 Delivery confirmed! Order completed successfully.',
    data: donation,
  });
});

module.exports = {
  createDonation,
  getDonations,
  getDonationById,
  updateDonation,
  deleteDonation,
  getNearbyNGOs,
  acceptDonation,
  rejectDonation,
  assignVolunteer,
  updateDeliveryStatus,
  trackDonation,
  trackVolunteerByPhone,
  ngoSelfPickupDecision,
  predictDonationETA,
  foodSafetyReview,
  volunteerRespondInvitation,
  volunteerCompleteDelivery,
  ngoConfirmDelivery,
};


