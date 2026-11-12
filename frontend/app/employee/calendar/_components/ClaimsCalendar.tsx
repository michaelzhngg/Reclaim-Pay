"use client";

import "@bryntum/calendar/fontawesome/css/fontawesome.css";
import "@bryntum/calendar/fontawesome/css/solid.css";
import "@bryntum/calendar/calendar.css";
import "@bryntum/calendar/svalbard-light.css";
import "./claims-calendar.css";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EventList, EventModel, Widget } from "@bryntum/calendar";
import { BryntumCalendar } from "@bryntum/calendar-react";
import { historyHref, latestEventDay, reimIdFromEventId, TONE_ICON, TONE_LABEL, type ClaimCalendarEvent, type EventTone } from "../_lib/events";

const TONES: EventTone[] = ["auto", "hr", "paid"];

// Below this a month cell can't fit "RC-6DE03699" on one line, even with "Submitted" wrapped above it.
const MONTH_VIEW_MIN_WIDTH = 700;

const MODES = {
  day: null,
  week: null,
  year: null,
  list: null,
  month: {
    sixWeeks: false,
    showWeekColumn: false,
    showWeekNumber: false,
    eventHeight: 36,
    // A word joiner keeps "RC-1AE03699" whole when the label wraps at its hyphen.
    eventRenderer: ({ eventRecord }: { eventRecord: EventModel }) => eventRecord.name.replace("RC-", "RC-⁠"),
  },
  // Bryntum's "list" mode is a wide spreadsheet-style grid. Agenda is its list grouped by day, and it fits a phone.
  agenda: {
    range: "month",
    listRangeMenu: null,
    eventHeight: 44,
    descriptionRenderer: (view: Widget) => (view as EventList).date.toLocaleDateString("en-MY", { month: "long", year: "numeric" }),
  },
};

// The screen width picks the view, so the toolbar keeps only date navigation.
const TBAR = { items: { modeSelector: false } };

export default function ClaimsCalendar({ events }: { events: ClaimCalendarEvent[] }) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Opens on the newest event once; after that the toolbar owns the date.
  const [openingDate] = useState(() => latestEventDay(events) ?? new Date());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Bryntum marks events role="button" but only fires eventClick for the pointer. Listening on
  // document also covers the "+N more" popup, which floats outside this component's DOM.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const eventId = (e.target as HTMLElement).closest<HTMLElement>(".claim-event[data-event-id]")?.dataset.eventId;
      if (!eventId) return;
      e.preventDefault();
      router.push(historyHref(reimIdFromEventId(eventId)));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-2 font-body text-sm text-ink">
          {TONES.map((tone) => (
            <li key={tone} className="flex items-center gap-2">
              <span aria-hidden className={`claim-legend-swatch claim-legend-${tone}`}>
                <i className={TONE_ICON[tone]} />
              </span>
              {TONE_LABEL[tone]}
            </li>
          ))}
        </ul>
        <p className="font-body text-xs text-ink-muted">
          Built on a Bryntum Calendar trial, so it shows a &ldquo;Trial Version&rdquo; watermark.
        </p>
      </div>

      <div ref={hostRef} className="claims-calendar h-[calc(100dvh-16rem)] min-h-[40rem] min-w-0 overflow-hidden rounded-card shadow-ambient bg-surface">
        {width !== null && (
          <BryntumCalendar
            date={openingDate}
            mode={width >= MONTH_VIEW_MIN_WIDTH ? "month" : "agenda"}
            modes={MODES}
            events={events}
            readOnly
            sidebar={false}
            tbar={TBAR}
            eventEditFeature={false}
            eventMenuFeature={false}
            scheduleMenuFeature={false}
            eventTooltipFeature={false}
            onEventClick={({ eventRecord }) => {
              router.push(historyHref(String(eventRecord.get("reimId"))));
            }}
          />
        )}
      </div>
    </div>
  );
}
