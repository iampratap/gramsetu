import { useEffect, useState } from "react";
import { getToken } from "./api.js";

export function useLiveSpeakers() {
  const [speakers, setSpeakers] = useState([]);
  const [reports, setReports] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket;
    let timer;
    let closed = false;
    let retry = 1000;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/live?token=${encodeURIComponent(getToken() || "")}`);
      socket.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "snapshot") setSpeakers(message.speakers);
        if (message.type === "speaker") {
          setSpeakers((current) => {
            const index = current.findIndex((item) => item.id === message.speaker.id);
            if (index === -1) return [...current, message.speaker];
            const next = current.slice();
            next[index] = message.speaker;
            return next;
          });
        }
        if (message.type === "report") setReports((current) => [message.report, ...current].slice(0, 30));
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { speakers, reports, connected };
}

export function useTicker(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
