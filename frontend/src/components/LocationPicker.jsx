import { useEffect, useRef, useState } from "react";
import { INDIA_CENTER, L, addBaseLayers, parseCoordinate, pinIcon } from "../map.js";

const round = (value) => Math.round(value * 1e6) / 1e6;

/** Latitude/longitude inputs with a map: click to place the pin, drag it to adjust. */
export function LocationPicker({ latitude, longitude, onChange, fallbackCenter }) {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState("");

  const lat = parseCoordinate(latitude, 90);
  const lng = parseCoordinate(longitude, 180);
  const placed = lat !== null && lng !== null;

  useEffect(() => {
    const map = L.map(holder.current, { scrollWheelZoom: false });
    addBaseLayers(map);
    if (placed) map.setView([lat, lng], 16);
    else if (fallbackCenter) map.setView(fallbackCenter, 12);
    else map.setView(INDIA_CENTER, 5);
    map.on("click", (event) => onChangeRef.current(round(event.latlng.lat), round(event.latlng.lng)));
    mapRef.current = map;
    // The modal animates in; measure again once it has its final size.
    const timer = setTimeout(() => map.invalidateSize(), 250);
    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!placed) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { draggable: true, icon: pinIcon("map-pin-edit"), autoPan: true })
        .on("dragend", (event) => {
          const point = event.target.getLatLng();
          onChangeRef.current(round(point.lat), round(point.lng));
        })
        .addTo(map);
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }
    if (!map.getBounds().contains([lat, lng])) map.panTo([lat, lng]);
  }, [placed, lat, lng]);

  function locateMe() {
    if (!navigator.geolocation) {
      setHint("This browser cannot share its location.");
      return;
    }
    setLocating(true);
    setHint("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const next = [round(position.coords.latitude), round(position.coords.longitude)];
        onChangeRef.current(...next);
        mapRef.current?.setView(next, 17);
        setHint(`Accurate to about ${Math.round(position.coords.accuracy)} m. Drag the pin to the exact spot.`);
      },
      (error) => {
        setLocating(false);
        setHint(error.code === 1 ? "Location permission was denied." : "Could not get this device's location.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  return (
    <div className="location-picker">
      <div className="location-fields">
        <label>
          <span>Latitude</span>
          <input
            inputMode="decimal"
            value={latitude ?? ""}
            onChange={(event) => onChange(event.target.value, longitude ?? "")}
            placeholder="e.g. 27.5530"
          />
        </label>
        <label>
          <span>Longitude</span>
          <input
            inputMode="decimal"
            value={longitude ?? ""}
            onChange={(event) => onChange(latitude ?? "", event.target.value)}
            placeholder="e.g. 76.6346"
          />
        </label>
        <button className="btn ghost small" type="button" onClick={locateMe} disabled={locating}>
          {locating ? "Locating…" : "Use my location"}
        </button>
        {placed ? (
          <button className="btn ghost small" type="button" onClick={() => onChange("", "")}>
            Clear
          </button>
        ) : null}
      </div>
      <div ref={holder} className="location-map" />
      <small className="muted">
        {hint || (placed ? "Drag the pin to adjust." : "Click the map where the speaker is installed, or type the coordinates.")}
      </small>
    </div>
  );
}
