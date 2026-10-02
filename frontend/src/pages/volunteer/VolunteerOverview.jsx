// pages/volunteer/VolunteerOverview.jsx
// Enhanced with:
//  - Start/Stop Tracking toggle (calls backend, starts GPS beacon)
//  - Nearby donation notification polling (every 10s while tracking)
//  - Browser Notification API for new nearby donations
//  - In-app notification modal with Accept / Decline buttons (first-accept-wins)
//  - Food Safety Review card when volunteer is at pickup location

import { useEffect, useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  FiTruck,
  FiCheckCircle,
  FiStar,
  FiRadio,
  FiWifiOff,
  FiMapPin,
  FiBell,
  FiX,
  FiNavigation,
  FiClock,
  FiPackage,
  FiAlertTriangle,
  FiThumbsUp,
  FiThumbsDown,
} from 'react-icons/fi';
import DashboardLayout from '../../components/DashboardLayout';
import StatCard from '../../components/StatCard';
import DonationCard from '../../components/DonationCard';
import Loader from '../../components/Loader';
import DeleteConfirmModal from '../../components/DeleteConfirmModal';
import VolunteerTrackingBeacon from '../../components/VolunteerTrackingBeacon';
import {
  getMyPickups,
  getMyVolunteerProfile,
  startTracking,
  stopTracking,
  getNearbyDonations,
  volunteerAcceptDonation,
} from '../../services/otherServices';
import {
  submitFoodSafetyReview,
  deleteDonation,
  respondVolunteerInvitation,
  completeVolunteerDelivery,
  getLatestEspTestForDonation,
  startEspTest,
  completeEspTest,
} from '../../services/donationService';

const POLL_INTERVAL_MS = 10000; // poll nearby donations every 10 seconds

// ── Browser Notification permission helper ──────────────────────────────────
async function requestBrowserNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function fireBrowserNotification(donation) {
  if (Notification.permission !== 'granted') return;
  const n = new Notification('🍱 New Food Donation Nearby!', {
    body: `${donation.foodName} — ${donation.distanceKm ?? '?'} km away\nPickup: ${donation.pickupLocation?.address}\nExpiry: ${new Date(donation.expiryDate).toLocaleTimeString()}`,
    icon: '/favicon.ico',
    tag: donation._id, // prevent duplicate notifications for same donation
  });
  n.onclick = () => window.focus();
}

// ── Notification Modal ──────────────────────────────────────────────────────
const NearbyDonationModal = ({ donations, onAccept, onDecline, onDismissAll }) => {
  if (!donations.length) return null;
  const d = donations[0]; // show one at a time

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-2xl border border-emerald-200 bg-white shadow-2xl dark:border-emerald-800 dark:bg-gray-900 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-4">
          <div className="flex items-center gap-2 text-white">
            <FiBell className="animate-bounce" size={20} />
            <span className="font-bold text-lg">New Food Donation Nearby!</span>
          </div>
          <button onClick={onDismissAll} className="text-white/80 hover:text-white transition">
            <FiX size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-emerald-100 dark:bg-emerald-900/40 p-3">
              <FiPackage className="text-emerald-600 dark:text-emerald-400" size={22} />
            </div>
            <div className="flex-1">
              <p className="font-bold text-gray-900 dark:text-gray-50 text-base">{d.foodName}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 capitalize">{d.category}</p>
            </div>
            {d.distanceKm != null && (
              <span className="shrink-0 rounded-full bg-teal-100 px-3 py-1 text-sm font-bold text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
                {d.distanceKm} km
              </span>
            )}
          </div>

          <div className="space-y-1.5 text-sm text-gray-600 dark:text-gray-300">
            {d.pickupLocation?.address && (
              <p className="flex items-center gap-2">
                <FiMapPin size={14} className="shrink-0 text-gray-400" />
                {d.pickupLocation.address}
              </p>
            )}
            <p className="flex items-center gap-2">
              <FiClock size={14} className="shrink-0 text-gray-400" />
              Expires: {new Date(d.expiryDate).toLocaleString()}
            </p>
            {d.quantity && (
              <p className="flex items-center gap-2">
                <FiPackage size={14} className="shrink-0 text-gray-400" />
                {typeof d.quantity === 'object'
                  ? `${d.quantity.value} ${d.quantity.unit}`
                  : d.quantity}
              </p>
            )}
          </div>

          {donations.length > 1 && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              +{donations.length - 1} more nearby donation{donations.length > 2 ? 's' : ''}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-5 pb-5">
          <button
            onClick={() => onDecline(d._id)}
            className="flex-1 rounded-xl border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Decline
          </button>
          <button
            onClick={() => onAccept(d._id)}
            className="flex-1 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 py-3 text-sm font-bold text-white transition hover:opacity-90 shadow-lg"
          >
            ✅ Accept Pickup
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Volunteer Invitation Card ────────────────────────────────────────────────
const VolunteerInvitationCard = ({ donation, onResponse }) => {
  const [submitting, setSubmitting] = useState(false);

  const handleResponse = async (accept) => {
    setSubmitting(true);
    try {
      const res = await respondVolunteerInvitation(donation._id, accept);
      toast.success(res.data.message || (accept ? 'Invitation accepted!' : 'Invitation declined.'));
      onResponse();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to respond to invitation.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-6 rounded-2xl border-2 border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40 overflow-hidden shadow-lg">
      <div className="flex items-center gap-3 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-4 text-white">
        <FiTruck size={22} className="animate-bounce" />
        <div>
          <p className="font-bold text-base">New Pickup Invitation from NGO!</p>
          <p className="text-blue-100 text-xs">Please confirm if you accept this pickup task</p>
        </div>
      </div>
      <div className="p-5 space-y-3">
        <p className="font-bold text-gray-900 dark:text-gray-100 text-base">🍱 {donation.foodName}</p>
        {donation.pickupLocation?.address && (
          <p className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1">
            <FiMapPin size={12} /> Pickup Address: {donation.pickupLocation.address}
          </p>
        )}
        {donation.acceptedBy?.name && (
          <p className="text-xs text-blue-700 dark:text-blue-300 font-semibold">
            NGO: {donation.acceptedBy.name}
          </p>
        )}
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => handleResponse(false)}
            disabled={submitting}
            className="flex-1 rounded-xl border border-red-300 bg-red-50 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100 transition disabled:opacity-50"
          >
            ❌ Decline / Reject
          </button>
          <button
            onClick={() => handleResponse(true)}
            disabled={submitting}
            className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition shadow-md disabled:opacity-50"
          >
            ✅ Accept Invitation
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Food Safety Review Card ──────────────────────────────────────────────────
const FoodSafetyReviewCard = ({ donation, onReviewSubmitted }) => {
  const [submitting, setSubmitting] = useState(null); // 'safe' | 'spoiled' | null
  const [confirmed, setConfirmed] = useState(null);   // pre-confirmation step
  const [espScore, setEspScore] = useState(null);
  const [testDetails, setTestDetails] = useState(null);
  const [loadingScore, setLoadingScore] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchTestScore = useCallback(() => {
    setLoadingScore(true);
    getLatestEspTestForDonation(donation._id)
      .then((res) => {
        const test = res.data?.data;
        if (test?.foodQualityScore != null) {
          setEspScore(test.foodQualityScore);
          setTestDetails(test);
        } else if (test) {
          setEspScore(null);
          setTestDetails(test);
        } else {
          setEspScore(null);
          setTestDetails(null);
        }
      })
      .catch(() => {
        setEspScore(null);
        setTestDetails(null);
      })
      .finally(() => {
        setLoadingScore(false);
      });
  }, [donation._id]);

  useEffect(() => {
    fetchTestScore();
  }, [fetchTestScore]);

  const handleStartTest = async () => {
    setActionLoading(true);
    try {
      await startEspTest(donation._id, 'ESP32-001');
      toast.success('ESP32-001 food test started! ESP32 can now send readings.');
      fetchTestScore();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not start ESP32 food test');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCompleteActiveTest = async () => {
    if (!testDetails?.testId) return;
    setActionLoading(true);
    try {
      const res = await completeEspTest(testDetails.testId);
      const score = res.data?.data?.foodQualityScore;
      toast.success(score != null ? `Food test completed! Score: ${score}%` : 'Food test completed!');
      fetchTestScore();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not complete food test');
    } finally {
      setActionLoading(false);
    }
  };

  const isSafeAllowed = espScore !== null && espScore >= 50;
  const isUnsafeAllowed = espScore !== null && espScore < 50;

  const handleReview = async (isSafe) => {
    setSubmitting(isSafe ? 'safe' : 'spoiled');
    try {
      const res = await submitFoodSafetyReview(donation._id, isSafe);
      const msg = res.data.message || (isSafe ? 'Food marked as safe!' : 'Food marked as spoiled.');
      toast.success(msg, { duration: 5000 });
      onReviewSubmitted();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit review. Try again.');
    } finally {
      setSubmitting(null);
      setConfirmed(null);
    }
  };

  return (
    <div className="mb-6 rounded-2xl border-2 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 overflow-hidden shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-3 bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-4">
        <FiAlertTriangle className="animate-pulse text-white" size={22} />
        <div>
          <p className="font-bold text-white text-base">Food Safety Inspection Required</p>
          <p className="text-amber-100 text-xs">You have arrived at the pickup location</p>
        </div>
      </div>

      {/* Donation info & ESP32 Health Score */}
      <div className="px-5 pt-4 pb-2">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          🍱 {donation.foodName}
        </p>
        {donation.pickupLocation?.address && (
          <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 mt-1">
            <FiMapPin size={11} /> {donation.pickupLocation.address}
          </p>
        )}

        {/* ESP32 Food Health Score Display */}
        {loadingScore ? (
          <div className="mt-3 rounded-xl bg-white/80 p-3 dark:bg-gray-800/80 border border-amber-200 dark:border-amber-800 text-xs text-gray-500 animate-pulse">
            Loading ESP32 Food Health Score…
          </div>
        ) : espScore !== null ? (
          <div className="mt-3 rounded-xl bg-white/80 p-3 dark:bg-gray-800/80 border border-amber-200 dark:border-amber-800">
            <div className="flex items-center justify-between text-sm font-bold text-gray-800 dark:text-gray-100">
              <span>
                Food Health Score: <strong className={espScore >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{espScore}%</strong>
              </span>
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                espScore >= 50
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
              }`}>
                Status: {espScore >= 50 ? 'SAFE' : 'UNSAFE'}
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl bg-white/80 p-3 dark:bg-gray-800/80 border border-amber-200 dark:border-amber-800 flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm font-semibold text-gray-600 dark:text-gray-400">
              <span>
                Food Health Score: <span className="font-bold text-amber-600 dark:text-amber-400">Not available</span>
              </span>
              <button
                onClick={fetchTestScore}
                className="text-xs text-amber-700 dark:text-amber-300 font-bold underline"
              >
                🔄 Refresh
              </button>
            </div>
            {testDetails?.status === 'active' ? (
              <button
                onClick={handleCompleteActiveTest}
                disabled={actionLoading}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white shadow hover:bg-amber-700 transition disabled:opacity-50"
              >
                {actionLoading ? 'Calculating…' : '⚡ Complete ESP32 Test (ESP32-001) & Calculate Score'}
              </button>
            ) : (
              <button
                onClick={handleStartTest}
                disabled={actionLoading}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow hover:bg-blue-700 transition disabled:opacity-50"
              >
                {actionLoading ? 'Starting…' : '▶ Start ESP32 Test (ESP32-001)'}
              </button>
            )}
          </div>
        )}

        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          Please inspect the food carefully before picking it up. Your review will be sent to the NGO.
        </p>
      </div>

      {/* Confirmation step / Buttons */}
      {confirmed === null ? (
        <div className="flex gap-3 px-5 py-4">
          <button
            onClick={() => setConfirmed('safe')}
            disabled={!isSafeAllowed || !!submitting}
            title={!isSafeAllowed ? (espScore === null ? 'ESP32 Food Health Score not available' : `Disabled: ESP32 Health Score is ${espScore}% (< 50% UNSAFE)`) : ''}
            className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold shadow transition ${
              isSafeAllowed
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-emerald-600 text-white opacity-40 grayscale blur-[0.5px] cursor-not-allowed pointer-events-none'
            }`}
          >
            <FiThumbsUp size={16} />
            SAFE
          </button>
          <button
            onClick={() => setConfirmed('spoiled')}
            disabled={!isUnsafeAllowed || !!submitting}
            title={!isUnsafeAllowed ? (espScore === null ? 'ESP32 Food Health Score not available' : `Disabled: ESP32 Health Score is ${espScore}% (>= 50% SAFE)`) : ''}
            className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold shadow transition ${
              isUnsafeAllowed
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-red-600 text-white opacity-40 grayscale blur-[0.5px] cursor-not-allowed pointer-events-none'
            }`}
          >
            <FiThumbsDown size={16} />
            UNSAFE
          </button>
        </div>
      ) : (
        /* Confirm dialog */
        <div className="px-5 py-4 space-y-3">
          <div className={`rounded-xl border p-3 text-sm ${
            confirmed === 'safe'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
              : 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200'
          }`}>
            {confirmed === 'safe'
              ? `✅ You are confirming the food is SAFE (ESP32 Health Score: ${espScore}%). The NGO will be notified and you will start delivery.`
              : `❌ You are confirming the food is UNSAFE (ESP32 Health Score: ${espScore}%). The NGO will be notified and the pickup will be cancelled.`}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmed(null)}
              disabled={!!submitting}
              className="flex-1 rounded-xl border border-gray-300 bg-white py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              Go Back
            </button>
            <button
              onClick={() => handleReview(confirmed === 'safe')}
              disabled={!!submitting}
              className={`flex-1 rounded-xl py-2.5 text-sm font-bold text-white shadow transition disabled:opacity-60 ${
                confirmed === 'safe'
                  ? 'bg-emerald-600 hover:bg-emerald-700'
                  : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {submitting ? 'Submitting…' : 'Confirm & Send to NGO'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────────
const VolunteerOverview = () => {
  const [pickups, setPickups] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Tracking state
  const [isTracking, setIsTracking] = useState(false);
  const [trackingLoading, setTrackingLoading] = useState(false);

  // Deletion state
  const [deleteTargetId, setDeleteTargetId] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Nearby donation notifications
  const [nearbyDonations, setNearbyDonations] = useState([]);
  const [declinedIds, setDeclinedIds] = useState(new Set());
  const [acceptingId, setAcceptingId] = useState(null);
  const pollRef = useRef(null);
  const notifiedIdsRef = useRef(new Set()); // track which IDs already got browser notification

  // ── Load initial data ──────────────────────────────────────────────────
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getMyPickups(), getMyVolunteerProfile()])
      .then(([pickupsRes, profileRes]) => {
        setPickups(pickupsRes.data.data);
        const prof = profileRes.data.data;
        setProfile(prof);
        // Restore tracking state from profile
        setIsTracking(prof.trackingEnabled || false);
      })
      .finally(() => setLoading(false));
  }, []);

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    setDeleteLoading(true);
    try {
      await deleteDonation(deleteTargetId);
      toast.success('Record deleted from dashboard');
      setDeleteTargetId(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete record');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleCompleteDelivery = async (donationId) => {
    try {
      const res = await completeVolunteerDelivery(donationId);
      toast.success(res.data.message || 'Delivery marked complete! NGO notified.');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not mark delivery complete');
    }
  };

  useEffect(() => {
    load();
    requestBrowserNotificationPermission();
  }, [load]);

  // ── Nearby donation poll (runs only while tracking) ────────────────────
  const pollNearby = useCallback(async () => {
    try {
      const { data } = await getNearbyDonations(5);
      const fresh = (data.data || []).filter((d) => !declinedIds.has(d._id));
      setNearbyDonations(fresh);

      // Fire browser notification for truly new donations
      fresh.forEach((d) => {
        if (!notifiedIdsRef.current.has(d._id)) {
          notifiedIdsRef.current.add(d._id);
          fireBrowserNotification(d);
        }
      });
    } catch {
      // silent
    }
  }, [declinedIds]);

  useEffect(() => {
    if (isTracking) {
      pollNearby(); // immediate first poll
      pollRef.current = setInterval(pollNearby, POLL_INTERVAL_MS);
    } else {
      clearInterval(pollRef.current);
      setNearbyDonations([]);
    }
    return () => clearInterval(pollRef.current);
  }, [isTracking, pollNearby]);

  // ── Start / Stop Tracking ──────────────────────────────────────────────
  const handleStartTracking = async () => {
    setTrackingLoading(true);
    try {
      await startTracking();
      setIsTracking(true);
      toast.success('🟢 Tracking started! You will be notified of nearby donations.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not start tracking');
    } finally {
      setTrackingLoading(false);
    }
  };

  const handleStopTracking = async () => {
    setTrackingLoading(true);
    try {
      await stopTracking();
      setIsTracking(false);
      setNearbyDonations([]);
      notifiedIdsRef.current.clear();
      toast('🔴 Tracking stopped. You won\'t receive new donation alerts.', { icon: '📴' });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not stop tracking');
    } finally {
      setTrackingLoading(false);
    }
  };

  // ── Accept donation (first-accept-wins) ───────────────────────────────
  const handleAccept = async (donationId) => {
    setAcceptingId(donationId);
    try {
      await volunteerAcceptDonation(donationId);
      toast.success('✅ Donation accepted! Head to the pickup location.');
      // Remove from nearby list and reload pickups
      setNearbyDonations((prev) => prev.filter((d) => d._id !== donationId));
      load();
    } catch (err) {
      const msg = err.response?.data?.message || 'Could not accept donation';
      if (msg.toLowerCase().includes('no longer available')) {
        toast.error('⚡ Sorry — another volunteer accepted it first!');
        setNearbyDonations((prev) => prev.filter((d) => d._id !== donationId));
      } else {
        toast.error(msg);
      }
    } finally {
      setAcceptingId(null);
    }
  };

  // ── Decline: just hide from this volunteer's view ─────────────────────
  const handleDecline = (donationId) => {
    setDeclinedIds((prev) => new Set(prev).add(donationId));
    setNearbyDonations((prev) => prev.filter((d) => d._id !== donationId));
    toast('Donation declined. You can find it in the list if you change your mind.', { icon: '↩️' });
  };

  const handleDismissAll = () => {
    nearbyDonations.forEach((d) => declinedIds.add(d._id));
    setDeclinedIds(new Set(declinedIds));
    setNearbyDonations([]);
  };

  // ── Categorize pickups for workflow ───────────────────────────────────
  const pendingInvitations = pickups.filter(
    (d) => d.status === 'assigned_pending_volunteer' || d.volunteerInvitationStatus === 'pending'
  );
  const pickupsNeedingReview = pickups.filter(
    (d) => d.status === 'out_for_pickup' && (d.volunteerInvitationStatus === 'accepted' || !d.volunteerInvitationStatus || d.volunteerInvitationStatus === 'none')
  );

  return (
    <DashboardLayout>
      {/* ── Nearby donation notification modal ── */}
      {nearbyDonations.length > 0 && (
        <NearbyDonationModal
          donations={nearbyDonations}
          onAccept={handleAccept}
          onDecline={handleDecline}
          onDismissAll={handleDismissAll}
        />
      )}

      {/* ── Header ── */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">Volunteer Overview</h1>
          {profile && !profile.isApproved && (
            <span className="badge bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 mt-1 inline-block">
              Pending admin approval
            </span>
          )}
        </div>

        {/* ── Start / Stop Tracking Button ── */}
        <div className="flex flex-col items-end gap-2">
          {isTracking ? (
            <button
              onClick={handleStopTracking}
              disabled={trackingLoading}
              className="flex items-center gap-2 rounded-xl border-2 border-red-400 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 transition hover:bg-red-100 dark:border-red-600 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
            >
              <FiWifiOff size={16} />
              {trackingLoading ? 'Stopping…' : 'Stop Tracking'}
            </button>
          ) : (
            <button
              onClick={handleStartTracking}
              disabled={trackingLoading}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg transition hover:opacity-90"
            >
              <FiRadio className={trackingLoading ? 'animate-pulse' : ''} size={16} />
              {trackingLoading ? 'Starting…' : '▶ Start Tracking'}
            </button>
          )}

          {/* GPS Beacon Status Pill */}
          <VolunteerTrackingBeacon isTracking={isTracking} />

          {isTracking && (
            <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[260px] text-right">
              📡 Scanning for nearby donations within 5 km every 10 seconds
            </p>
          )}
        </div>
      </div>

      {/* ── Notification bell indicator ── */}
      {isTracking && nearbyDonations.length === 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
          <FiBell className="animate-pulse" size={16} />
          <span>Listening for nearby donations… You'll be notified automatically.</span>
        </div>
      )}

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-8">
        <StatCard icon={FiTruck} label="Active Pickups" value={pickups.length} accent="primary" />
        <StatCard icon={FiCheckCircle} label="Completed Pickups" value={profile?.totalPickupsCompleted || 0} accent="blue" />
        <StatCard icon={FiStar} label="Rating" value={profile?.rating?.toFixed(1) || '—'} accent="accent" />
      </div>

      {/* ── Tracking status summary ── */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <FiRadio size={14} /> Tracking Status
        </h2>
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Live Tracking: </span>
            {isTracking ? (
              <span className="font-bold text-emerald-600 dark:text-emerald-400">🟢 Active</span>
            ) : (
              <span className="font-bold text-gray-400">🔴 Offline</span>
            )}
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Status: </span>
            <span className={`font-bold capitalize ${
              profile?.availabilityStatus === 'available' ? 'text-emerald-600 dark:text-emerald-400' :
              profile?.availabilityStatus === 'busy' ? 'text-amber-600 dark:text-amber-400' :
              'text-gray-400'
            }`}>
              {profile?.availabilityStatus || 'offline'}
            </span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Vehicle: </span>
            <span className="font-semibold capitalize text-gray-700 dark:text-gray-200">
              {profile?.vehicleType || '—'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Pending NGO Pickup Invitations (Accept / Decline) ── */}
      {pendingInvitations.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-blue-700 dark:text-blue-400">
            <FiTruck size={18} />
            Pickup Invitations (Action Required)
          </h2>
          <div className="space-y-4">
            {pendingInvitations.map((d) => (
              <VolunteerInvitationCard key={d._id} donation={d} onResponse={load} />
            ))}
          </div>
        </div>
      )}

      {/* ── Food Safety Review Cards (When Accepted & At Pickup Location) ── */}
      {pickupsNeedingReview.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-amber-700 dark:text-amber-400">
            <FiAlertTriangle size={18} />
            Food Safety Inspection
          </h2>
          <div className="space-y-4">
            {pickupsNeedingReview.map((d) => (
              <FoodSafetyReviewCard key={d._id} donation={d} onReviewSubmitted={load} />
            ))}
          </div>
        </div>
      )}

      {/* ── Assigned Pickups ── */}
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-50">Assigned Pickups</h2>
      {loading ? (
        <Loader />
      ) : pickups.length === 0 ? (
        <div className="card text-center text-sm text-gray-500 dark:text-gray-400">
          No active pickups assigned to you.{' '}
          {!isTracking && (
            <span>
              Click <strong>Start Tracking</strong> to receive nearby donation alerts.
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {pickups.map((d) => (
            <DonationCard
              key={d._id}
              donation={d}
              actions={
                <div className="flex flex-wrap items-center gap-2 w-full">
                  {d.status === 'picked_up' && (
                    <button
                      onClick={() => handleCompleteDelivery(d._id)}
                      className="btn-primary !py-2 !px-4 text-xs font-bold shadow-md bg-emerald-600 hover:bg-emerald-700 text-white animate-pulse flex items-center gap-1"
                    >
                      📦 Mark Delivery Completed (Arrived at NGO)
                    </button>
                  )}

                  {d.status === 'delivery_pending_ngo_confirmation' && (
                    <span className="text-xs text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 px-2.5 py-1 rounded-md border border-blue-200 dark:border-blue-800 font-semibold">
                      ⏳ Delivery Complete — Waiting for NGO to confirm receipt
                    </span>
                  )}

                  {['expired', 'cancelled', 'delivered', 'rejected'].includes(d.status) && (
                    <button
                      onClick={() => setDeleteTargetId(d._id)}
                      className="btn-danger !py-1.5 !px-3 text-xs flex items-center gap-1 ml-auto"
                      title="Delete record"
                    >
                      🗑️ Delete Record
                    </button>
                  )}
                </div>
              }
            />
          ))}
        </div>
      )}

      {/* Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={Boolean(deleteTargetId)}
        title="Delete Record?"
        message="Are you sure you want to delete this record? This action cannot be undone."
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTargetId(null)}
        loading={deleteLoading}
      />
    </DashboardLayout>
  );
};

export default VolunteerOverview;
