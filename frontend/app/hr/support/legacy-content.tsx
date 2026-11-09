"use client";

import { FileText, Send, Phone, ChevronDown } from "lucide-react";
import { useToast } from "@/components/toast/ToastProvider";

const NOT_BUILT = "Feature has not been implemented yet.";

const fieldCls =
  "w-full min-h-[44px] bg-surface text-ink px-3 rounded-control border border-line-strong focus:border-accent outline-none text-sm placeholder:text-ink-muted";

export default function SupportLegacyContent() {
  const { toast } = useToast();
  const showToast = () => toast({ tone: "info", title: NOT_BUILT });

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-5">
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">How can we help?</h1>
          <p className="mt-1 text-sm text-ink-muted max-w-2xl">
            Browse our frequently asked questions, or contact HR directly if you have issues with your claims.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
          <div className="md:col-span-1 space-y-4">
            <h2 className="font-display font-semibold text-lg text-ink">Quick Resources</h2>

            <ul className="bg-surface shadow-ambient rounded-card divide-y divide-line overflow-hidden">
              {[
                { title: "Claim Policy Guide", desc: "Understand what can be reimbursed." },
                { title: "Uploading Receipts", desc: "Best practices for OCR extraction." },
                { title: "Direct Deposit Setup", desc: "Learn how payouts are scheduled." },
              ].map((faq) => (
                <li key={faq.title}>
                  <button
                    type="button"
                    onClick={showToast}
                    className="w-full text-left px-4 py-3 min-h-[56px] hover:bg-surface-muted cursor-pointer transition-colors flex items-start gap-3"
                  >
                    <FileText className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      <span className="block font-body font-semibold text-sm text-ink">{faq.title}</span>
                      <span className="block font-body text-sm text-ink-muted mt-0.5">{faq.desc}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="p-4 sm:p-5 rounded-card shadow-ambient bg-surface">
              <h3 className="font-display font-semibold text-base text-ink mb-1 flex items-center gap-2">
                <Phone className="w-4 h-4 text-ink-muted" aria-hidden="true" />
                Urgent Escalations
              </h3>
              <p className="font-body text-sm text-ink-muted mb-4">Need immediate help with a rejected claim?</p>
              <button
                type="button"
                onClick={showToast}
                className="w-full min-h-[44px] border border-line-strong text-ink rounded-control font-semibold text-sm hover:bg-surface-muted transition-colors cursor-pointer"
              >
                Call HR Desk
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <section className="bg-surface shadow-ambient rounded-card overflow-hidden h-full flex flex-col">
              <div className="px-4 sm:px-6 py-4 border-b border-line">
                <h2 className="font-display font-semibold text-lg text-ink">Submit a Ticket</h2>
                <p className="font-body text-sm text-ink-muted mt-0.5">Send a direct message to support staff.</p>
              </div>

              <form
                className="p-4 sm:p-6 space-y-5 flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  showToast();
                }}
              >
                <div className="space-y-1.5">
                  <label htmlFor="support-issue" className="font-body text-sm font-medium text-ink">Issue Type</label>
                  <div className="relative">
                    <select id="support-issue" className={`appearance-none pr-10 cursor-pointer ${fieldCls}`}>
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
                  <label htmlFor="support-subject" className="font-body text-sm font-medium text-ink">Subject</label>
                  <input id="support-subject" type="text" placeholder="Brief description of the problem" className={fieldCls} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="support-message" className="font-body text-sm font-medium text-ink">Message Details</label>
                  <textarea
                    id="support-message"
                    rows={6}
                    placeholder="Include Claim IDs if relevant..."
                    className={`py-2.5 resize-none ${fieldCls}`}
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full flex items-center justify-center gap-2 min-h-[48px] bg-accent text-on-accent px-5 rounded-full font-semibold text-sm hover:bg-accent-hover transition-colors cursor-pointer"
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
