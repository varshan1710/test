// services/donationService.js
import api from './api';

export const createDonation = (formData) =>
  api.post('/donations', formData, { headers: { 'Content-Type': 'multipart/form-data' } });

export const getDonations = (params = {}) => api.get('/donations', { params });

export const getDonationById = (id) => api.get(`/donations/${id}`);

export const updateDonation = (id, formData) =>
  api.put(`/donations/${id}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });

export const deleteDonation = (id) => api.delete(`/donations/${id}`);

export const getNearbyNGOs = (id) => api.get(`/donations/${id}/nearby-ngos`);

export const acceptDonation = (id) => api.put(`/donations/${id}/accept`);

export const rejectDonation = (id, reason) => api.put(`/donations/${id}/reject`, { reason });

export const assignVolunteer = (id, volunteerId) =>
  api.put(`/donations/${id}/assign-volunteer`, { volunteerId });

export const updateDeliveryStatus = (id, status, note) =>
  api.put(`/donations/${id}/status`, { status, note });

export const trackDonation = (id) => api.get(`/donations/${id}/track`);

export const predictDonationETA = (id, vehicleType = 'bike') => api.post(`/donations/${id}/predict-eta`, { vehicleType });

export const trackVolunteerByPhone = (phone) => api.get(`/donations/track-by-phone/${encodeURIComponent(phone)}`);

export const submitFoodSafetyReview = (id, isSafe) => api.put(`/donations/${id}/food-review`, { isSafe });

export const respondVolunteerInvitation = (id, accept) => api.put(`/donations/${id}/volunteer-response`, { accept });

export const completeVolunteerDelivery = (id) => api.put(`/donations/${id}/volunteer-complete`);

export const confirmNgoDelivery = (id) => api.put(`/donations/${id}/ngo-confirm-delivery`);

export const getLatestEspTestForDonation = (donationId) => api.get(`/esp/tests/donation/${donationId}/latest`);

export const startEspTest = (donationId, deviceId = 'ESP32-001') =>
  api.post('/esp/tests/start', { donationId, deviceId });

export const completeEspTest = (testId) =>
  api.post(`/esp/tests/${testId}/complete`);


