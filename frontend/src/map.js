import L from "leaflet";
import "leaflet/dist/leaflet.css";

export const INDIA_CENTER = [22.5, 79];

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** Street map plus satellite imagery (handy for finding the exact pole or rooftop). */
export function addBaseLayers(map) {
  const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  });
  street.addTo(map);
  L.control.layers({ Map: street, Satellite: satellite }, null, { position: "topright" }).addTo(map);
}

export function pinIcon(className, inner = "") {
  return L.divIcon({
    className: "map-pin-wrap",
    html: `<span class="map-pin ${className}">${inner}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

export function parseCoordinate(value, limit) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

export { L };
