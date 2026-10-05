// Connected speaker sockets, keyed by speaker id. Kept in its own module so
// lib/http.js can check connectivity without importing the hub.
export const devices = new Map();

export function isDeviceConnected(speakerId) {
  return devices.has(speakerId);
}
