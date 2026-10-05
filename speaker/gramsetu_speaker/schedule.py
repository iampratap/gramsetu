"""Works out when schedules should play. Mirrors the server's Schedule model."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def _tz(schedule: dict) -> ZoneInfo:
    try:
        return ZoneInfo(schedule.get("timezone") or "Asia/Kolkata")
    except Exception:
        return ZoneInfo("Asia/Kolkata")


def runs_on(schedule: dict, day: date) -> bool:
    iso = day.isoformat()
    if iso < schedule["startDate"]:
        return False
    if schedule["repeat"] == "ONCE":
        return iso == schedule["startDate"]
    if schedule.get("endDate") and iso > schedule["endDate"]:
        return False
    if schedule["repeat"] == "WEEKLY":
        # Python: Monday=0 … Sunday=6. Server: Sunday=0 … Saturday=6.
        return (day.weekday() + 1) % 7 in schedule.get("daysOfWeek", [])
    return True


def _occurrences_on(schedule: dict, day: date):
    tz = _tz(schedule)
    for clock in schedule.get("times", []):
        hour, minute = (int(part) for part in clock.split(":"))
        yield datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)


def occurrence_key(schedule: dict, at: datetime) -> str:
    return f"{schedule['id']}@{at.astimezone(timezone.utc).isoformat()}"


def due(schedules: list[dict], now: datetime, grace_seconds: int):
    """Occurrences that started within the last `grace_seconds`."""
    for schedule in schedules:
        local_today = now.astimezone(_tz(schedule)).date()
        for day in (local_today - timedelta(days=1), local_today):
            if not runs_on(schedule, day):
                continue
            for at in _occurrences_on(schedule, day):
                late = (now - at).total_seconds()
                if 0 <= late <= grace_seconds:
                    yield schedule, at


def next_occurrence(schedules: list[dict], now: datetime, horizon_days: int = 8):
    best = None
    for schedule in schedules:
        local_today = now.astimezone(_tz(schedule)).date()
        for offset in range(horizon_days):
            day = local_today + timedelta(days=offset)
            if not runs_on(schedule, day):
                continue
            upcoming = [at for at in _occurrences_on(schedule, day) if at > now]
            if upcoming:
                at = min(upcoming)
                if best is None or at < best[1]:
                    best = (schedule, at)
                break
    return best
