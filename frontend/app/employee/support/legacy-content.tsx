"use client";

import { Send, ChevronDown } from "lucide-react";

const LABEL = "font-body text-sm font-medium text-ink";
const FIELD =
  "w-full min-h-[44px] bg-surface text-ink px-3 rounded-control border border-line-strong transition-colors font-body text-base md:text-sm placeholder:text-ink-muted";

const RESOURCES = [
  { title: "Claim Policy Guide", desc: "Understand what can be reimbursed." },
  { title: "Uploading Receipts", desc: "Best practices for OCR extraction." },
  { title: "Direct Deposit Setup", desc: "Learn how payouts are scheduled." },
];

export default function SupportLegacyContent() {
  return (
    <div className="min-h-full px-4 pt-6 pb-24 md:p-10 lg:p-12">
      <div className="max-w-6xl mx-auto">

        {/* ── Header ── */}
        <div className="max-w-2xl mb-8">
          <h2 className="font-display font-semibold text-2xl md:text-3xl text-ink mb-2">
            How can we help?
          </h2>
          <p className="text-ink-muted text-base font-body">
            Browse our frequently asked questions, or contact HR directly if you have issues with your claims.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

          {/* ── Left / Top: FAQ Quick Links ── */}
          <div className="md:col-span-1 space-y-6 min-w-0">
            <section>
              <h3 className="font-display font-semibold text-lg text-ink mb-3">Quick resources</h3>
              <ul className="bg-surface shadow-ambient rounded-card divide-y divide-line">
                {RESOURCES.map((faq) => (
                  <li key={faq.title} className="p-4">
                    <p className="font-body font-semibold text-sm text-ink">{faq.title}</p>
                    <p className="font-body text-xs text-ink-muted mt-1">{faq.desc}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="p-5 rounded-card shadow-ambient bg-surface">
              <h3 className="font-display font-semibold text-base text-ink mb-1">Urgent escalations</h3>
              <p className="font-body text-sm text-ink-muted mb-4">Need immediate help with a rejected claim?</p>
              <button
                type="button"
                className="w-full min-h-[44px] rounded-control border border-line-strong bg-surface text-ink font-semibold text-sm hover:bg-surface-muted transition-colors"
              >
                Call HR Desk
              </button>
            </section>
          </div>

          {/* ── Right / Main: Contact Form ── */}
          <div className="md:col-span-2 min-w-0">
            <section className="bg-surface shadow-ambient rounded-card overflow-hidden h-full flex flex-col">
              <div className="p-5 md:p-6 border-b border-line">
                <h3 className="font-display font-semibold text-lg text-ink mb-1">Submit a ticket</h3>
                <p className="font-body text-sm text-ink-muted">Send a direct message to support staff.</p>
              </div>

              <form className="p-5 md:p-6 space-y-5 flex-1" onSubmit={(e) => e.preventDefault()}>

                <div className="space-y-1.5">
                  <label htmlFor="support-issue" className={LABEL}>Issue type</label>
                  <div className="relative">
                    <select id="support-issue" className={`appearance-none pr-10 cursor-pointer ${FIELD}`}>
                      <option>Claim Rejected</option>
                      <option>Technical Issue (App Bug)</option>
                      <option>Payment Delayed</option>
                      <option>Update Banking Details</option>
                      <option>Other</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="support-subject" className={LABEL}>Subject</label>
                  <input id="support-subject" type="text" placeholder="Brief description of the problem" className={FIELD} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="support-message" className={LABEL}>Message details</label>
                  <textarea
                    id="support-message"
                    rows={6}
                    placeholder="Include claim IDs if relevant"
                    className={`py-2.5 resize-none ${FIELD}`}
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full sm:w-auto flex items-center justify-center gap-2 min-h-[44px] bg-accent text-on-accent px-5 rounded-full font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    <Send className="w-4 h-4" aria-hidden="true" />
                    Submit Request
                  </button>
                </div>
              </form>

            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
