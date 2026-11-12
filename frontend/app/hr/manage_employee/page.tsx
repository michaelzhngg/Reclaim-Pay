"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Building2, Eye, Loader2, Mail, Plus, Search, Send } from "lucide-react";
import { ErrorLine, Sheet } from "@/components/ui/Sheet";
import { btn } from "@/components/ui/styles";
import type { Department } from "@/lib/api/types";
import {
  createEmployee,
  getDepartments,
  listEmployees,
  resendInvite,
  type EmployeeRecord,
  type InviteResult,
} from "@/lib/actions/employees";

const fieldClass =
  "w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm text-ink disabled:bg-surface-muted disabled:text-ink-muted";
const labelClass = "block text-sm font-medium text-ink mb-1.5";

const schema = z.object({
  name: z.string().trim().min(1, { message: "Enter their full name." }).max(120),
  user_code: z.string().trim().max(40),
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  department_id: z.string(),
  role: z.enum(["Employee", "HR"]),
});
type FormValues = z.infer<typeof schema>;

type DepartmentsState = { list: Department[]; loading: boolean; error: string | null };

// ─── One-time invite link ───────────────────────────────────────────────────

function InviteLinkPanel({ invite, onDone }: { invite: InviteResult; onDone: () => void }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const fieldRef = useRef<HTMLInputElement>(null);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(invite.invite_link);
      setCopy("copied");
      window.setTimeout(() => setCopy("idle"), 2500);
    } catch {
      fieldRef.current?.select();
      setCopy("failed");
    }
  }

  return (
    <div className="px-5 py-5 space-y-4">
      <p role="status" className="text-sm text-ink">
        Invitation sent to <span className="font-semibold break-all">{invite.email}</span>. It is valid for 7 days.
      </p>

      <div>
        <label htmlFor="invite-link" className={labelClass}>Invitation link</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={fieldRef}
            id="invite-link"
            readOnly
            value={invite.invite_link}
            onFocus={(e) => e.currentTarget.select()}
            aria-describedby="invite-link-note"
            className={`${fieldClass} font-mono text-xs min-w-0 flex-1`}
          />
          <button type="button" onClick={copyLink} className={`${btn.secondary} shrink-0`}>
            {copy === "copied" ? "Copied" : "Copy link"}
          </button>
        </div>
        <p aria-live="polite" className="sr-only">{copy === "copied" ? "Link copied" : ""}</p>
        {copy === "failed" && (
          <p className="mt-2 text-sm text-danger">Copy didn&apos;t work here. The link is selected, so press Ctrl+C or Cmd+C.</p>
        )}
      </div>

      <p id="invite-link-note" className="text-sm text-ink-muted">
        If the email doesn&apos;t arrive, send this link to them yourself. It&apos;s shown only this once, and whoever has
        it can set this account&apos;s password.
      </p>

      <div className="flex justify-end pt-1">
        <button type="button" onClick={onDone} className={`${btn.dark} w-full sm:w-auto`}>Done</button>
      </div>
    </div>
  );
}

// ─── Add / view dialog ──────────────────────────────────────────────────────

function EmployeeForm({
  employee,
  departments,
  onCancel,
  onCreated,
}: {
  employee: EmployeeRecord | null;
  departments: DepartmentsState;
  onCancel: () => void;
  onCreated: (invite: InviteResult) => void;
}) {
  const isEdit = !!employee;
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: employee?.name ?? "",
      user_code: employee?.user_code ?? "",
      email: employee?.email ?? "",
      department_id: employee?.department_id ?? "",
      role: employee?.role === "HR" ? "HR" : "Employee",
    },
  });
  const { errors, isSubmitting } = form.formState;
  const role = useWatch({ control: form.control, name: "role" });

  async function onSubmit(values: FormValues) {
    setError(null);
    const result = await createEmployee({
      name: values.name,
      email: values.email,
      user_code: values.user_code || undefined,
      department_id: values.department_id || undefined,
      role: values.role,
    });
    if (result.error || !result.data) {
      setError(result.error ?? "We couldn't create the account. Try again.");
      return;
    }
    onCreated(result.data);
  }

  const errorId = (field: keyof FormValues) => (errors[field] ? `${field}-error` : undefined);

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex min-h-0 flex-col">
      <div className="overflow-y-auto px-5 py-5 space-y-4">
        {!isEdit && (
          <p className="text-sm text-ink-muted">
            They&apos;ll get an email with a link to set their own password.
          </p>
        )}

        <div>
          <label htmlFor="emp-name" className={labelClass}>Full name</label>
          <input id="emp-name" type="text" autoComplete="off" disabled={isEdit} className={fieldClass}
            aria-invalid={errors.name ? true : undefined} aria-describedby={errorId("name")} {...form.register("name")} />
          {errors.name && <p id="name-error" className="mt-1.5 text-sm text-danger">{errors.name.message}</p>}
        </div>

        <div>
          <label htmlFor="emp-email" className={labelClass}>Work email</label>
          <input id="emp-email" type="email" inputMode="email" autoComplete="off" spellCheck={false} disabled={isEdit}
            placeholder="name@company.com" className={fieldClass}
            aria-invalid={errors.email ? true : undefined} aria-describedby={errorId("email")} {...form.register("email")} />
          {errors.email && <p id="email-error" className="mt-1.5 text-sm text-danger">{errors.email.message}</p>}
        </div>

        <div>
          <label htmlFor="emp-code" className={labelClass}>
            Company ID <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input id="emp-code" type="text" autoComplete="off" disabled={isEdit} className={fieldClass} {...form.register("user_code")} />
        </div>

        <div>
          <label htmlFor="emp-dept" className={labelClass}>Department</label>
          <select id="emp-dept" disabled={isEdit || departments.loading} className={`${fieldClass} cursor-pointer`}
            aria-describedby={departments.error ? "dept-error" : undefined} {...form.register("department_id")}>
            <option value="">{departments.loading ? "Loading departments…" : "No department"}</option>
            {departments.list.map((d) => (
              <option key={d.department_id} value={d.department_id}>{d.name}</option>
            ))}
          </select>
          {departments.error && (
            <p id="dept-error" className="mt-1.5 text-sm text-danger">
              Departments didn&apos;t load. You can add the person without one.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="emp-role" className={labelClass}>System role</label>
          <select id="emp-role" disabled={isEdit} className={`${fieldClass} cursor-pointer`}
            aria-describedby={role === "HR" ? "role-warning" : undefined} {...form.register("role")}>
            <option value="Employee">Employee</option>
            <option value="HR">HR</option>
          </select>
          <div aria-live="polite">
            {role === "HR" && !isEdit && (
              <p id="role-warning" className="mt-2 rounded-control bg-warning-soft px-3 py-2 text-sm text-warning">
                HR accounts can approve claims and change autonomy settings. Only choose HR for people who run reimbursements.
              </p>
            )}
          </div>
        </div>

        {isEdit && (
          // TODO: wire to an employee update endpoint once one exists; there is none in backend/api/employee.py.
          <p className="text-sm text-ink-muted">Editing details is coming soon. Nothing here can be changed yet.</p>
        )}

        <ErrorLine error={error} />
      </div>

      <div className="flex flex-col-reverse gap-2.5 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={isSubmitting} className={btn.secondary}>
          {isEdit ? "Close" : "Cancel"}
        </button>
        {!isEdit && (
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting} className={btn.primary}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Sending invitation…
              </>
            ) : (
              "Create and send invitation"
            )}
          </button>
        )}
      </div>
    </form>
  );
}

// ─── Status cell ────────────────────────────────────────────────────────────

function StatusBadge({ emp }: { emp: EmployeeRecord }) {
  if (emp.invite_status === "pending") {
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-soft text-accent">Invited</span>;
  }
  if (emp.invite_status === "expired") {
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warning-soft text-warning">Invite expired</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-1.5 h-1.5 rounded-full ${emp.is_active ? "bg-success" : "bg-line-strong"}`} aria-hidden="true" />
      <p className={`text-xs font-medium ${emp.is_active ? "text-success" : "text-ink-muted"}`}>
        {emp.is_active ? "Active" : "Inactive"}
      </p>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
      role === "HR" ? "bg-warning-soft text-warning" : "bg-surface-muted text-ink"
    }`}>
      {role}
    </span>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

type DialogState =
  | { kind: "closed" }
  | { kind: "form"; employee: EmployeeRecord | null }
  | { kind: "invite"; invite: InviteResult; title: string };

export default function ManageEmployeePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [departments, setDepartments] = useState<DepartmentsState>({ list: [], loading: true, error: null });
  const [resending, setResending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const applyEmployees = useCallback((result: { data: EmployeeRecord[]; error: string | null }) => {
    setEmployees(result.data);
    setLoadError(result.error);
    setIsLoading(false);
  }, []);
  const reload = useCallback(() => listEmployees().then(applyEmployees), [applyEmployees]);

  useEffect(() => {
    listEmployees().then(applyEmployees);
    getDepartments().then((r) => setDepartments({ list: r.data, loading: false, error: r.error }));
  }, [applyEmployees]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return employees.filter(emp =>
      emp.name.toLowerCase().includes(q) ||
      emp.email.toLowerCase().includes(q) ||
      (emp.department_name ?? "").toLowerCase().includes(q)
    );
  }, [searchQuery, employees]);

  const closeDialog = () => setDialog({ kind: "closed" });

  async function handleResend(emp: EmployeeRecord) {
    setActionError(null);
    setResending(emp.user_id);
    const result = await resendInvite(emp.user_id);
    setResending(null);
    if (result.error || !result.data) {
      setActionError(result.error ?? "We couldn't send a new invitation. Try again.");
      return;
    }
    setDialog({ kind: "invite", invite: result.data, title: "New invitation sent" });
    reload();
  }

  const hrCount = employees.filter(e => e.role === "HR").length;
  const canResend = (emp: EmployeeRecord) => emp.is_active && emp.invite_status !== null;

  const rowActions = (emp: EmployeeRecord) => (
    <>
      {canResend(emp) && (
        <button
          type="button"
          onClick={() => handleResend(emp)}
          disabled={resending !== null}
          aria-busy={resending === emp.user_id}
          className={`${btn.secondary} px-3.5 text-[13px]`}
        >
          {resending === emp.user_id ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="w-4 h-4" aria-hidden="true" />
          )}
          Resend invitation
        </button>
      )}
      <button
        onClick={() => setDialog({ kind: "form", employee: emp })}
        type="button"
        className="inline-flex items-center justify-center w-11 h-11 text-ink-muted hover:text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer"
        aria-label={`View ${emp.name}`}
        title="View details"
      >
        <Eye className="w-4 h-4" aria-hidden="true" />
      </button>
    </>
  );

  const dialogTitle =
    dialog.kind === "invite" ? dialog.title
      : dialog.kind === "form" && dialog.employee ? dialog.employee.name
      : "Add employee";

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div>
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
          <div className="max-w-2xl">
            <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Manage Employees</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Add people, send their invitations and see who still has to set a password.
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              {isLoading ? (
                "Loading employees…"
              ) : (
                <>
                  <span className="font-mono text-ink">{employees.length}</span> employees ·{" "}
                  <span className="font-mono text-ink">{hrCount}</span> HR admins
                </>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setDialog({ kind: "form", employee: null })}
            className="flex items-center justify-center gap-2 rounded-full min-h-[44px] px-5 bg-accent text-on-accent font-body text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Add Employee
          </button>
        </div>

        <Sheet
          open={dialog.kind !== "closed"}
          titleId="employee-dialog-title"
          title={dialogTitle}
          busy={false}
          onClose={closeDialog}
        >
          {dialog.kind === "form" && (
            <EmployeeForm
              key={dialog.employee?.user_id ?? "new"}
              employee={dialog.employee}
              departments={departments}
              onCancel={closeDialog}
              onCreated={(invite) => {
                setDialog({ kind: "invite", invite, title: "Invitation sent" });
                reload();
              }}
            />
          )}
          {dialog.kind === "invite" && <InviteLinkPanel invite={dialog.invite} onDone={closeDialog} />}
        </Sheet>

        <div className="mb-4 flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted w-4 h-4" aria-hidden="true" />
            <input
              type="text"
              placeholder="Search by name, email, or department..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search employees"
              className="w-full min-h-[44px] pl-10 pr-3 bg-surface border border-line-strong rounded-control text-sm outline-none focus:border-accent placeholder:text-ink-muted"
            />
          </div>
        </div>

        <div aria-live="polite" className="empty:hidden mb-4">
          {actionError && (
            <p role="alert" className="rounded-control bg-danger-soft px-4 py-2.5 text-sm font-medium text-danger">{actionError}</p>
          )}
        </div>

        <div className="bg-surface shadow-ambient rounded-card overflow-hidden">
          {loadError && !isLoading ? (
            <div className="p-12 text-center" role="alert">
              <p className="font-display font-semibold text-lg text-ink">Employees didn&apos;t load</p>
              <p className="text-ink-muted text-sm mt-1">{loadError}</p>
              <button type="button" onClick={() => { setIsLoading(true); reload(); }} className={`${btn.secondary} mt-4`}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-surface-muted">
                      <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Employee</th>
                      <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Department</th>
                      <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Role</th>
                      <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Status</th>
                      <th className="py-3 px-6 text-xs font-semibold text-ink-muted text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {isLoading ? (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-ink-muted text-sm">Loading employees…</td>
                      </tr>
                    ) : filteredEmployees.map((emp) => (
                      <tr key={emp.user_id} className="hover:bg-surface-muted transition-colors">
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 shrink-0 rounded-full bg-surface-muted border border-line flex items-center justify-center font-semibold text-xs text-ink">
                              {emp.name.charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-sm text-ink">{emp.name}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <Mail className="w-3 h-3 text-ink-muted" aria-hidden="true" />
                                <p className="text-xs text-ink-muted">{emp.email}</p>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                            <p className="text-sm text-ink-muted">{emp.department_name ?? "Not set"}</p>
                          </div>
                        </td>
                        <td className="py-4 px-6"><RoleBadge role={emp.role} /></td>
                        <td className="py-4 px-6"><StatusBadge emp={emp} /></td>
                        <td className="py-4 px-6">
                          <div className="flex items-center justify-end gap-2">{rowActions(emp)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="md:hidden flex flex-col divide-y divide-line">
                {isLoading ? (
                  <div className="py-12 text-center text-ink-muted text-sm">Loading employees…</div>
                ) : filteredEmployees.map((emp) => (
                  <div key={emp.user_id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-surface-muted border border-line flex items-center justify-center font-semibold text-xs text-ink shrink-0">
                          {emp.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-ink truncate">{emp.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Mail className="w-3 h-3 text-ink-muted shrink-0" aria-hidden="true" />
                            <p className="text-xs text-ink-muted truncate">{emp.email}</p>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Building2 className="w-3 h-3 text-ink-muted shrink-0" aria-hidden="true" />
                            <p className="text-xs text-ink-muted">{emp.department_name ?? "Not set"}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <RoleBadge role={emp.role} />
                        <StatusBadge emp={emp} />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 mt-3 pt-3 border-t border-line">
                      {rowActions(emp)}
                    </div>
                  </div>
                ))}
              </div>

              {!isLoading && filteredEmployees.length === 0 && (
                <div className="p-12 text-center">
                  <Search className="w-8 h-8 mx-auto mb-3 text-ink-muted" aria-hidden="true" />
                  {employees.length === 0 ? (
                    <>
                      <p className="font-display font-semibold text-lg text-ink">No one here yet</p>
                      <p className="text-ink-muted text-sm mt-1">Add an employee to send their first invitation.</p>
                    </>
                  ) : (
                    <>
                      <p className="font-display font-semibold text-lg text-ink">No employees found</p>
                      <p className="text-ink-muted text-sm mt-1">No name, email or department matches that search.</p>
                    </>
                  )}
                </div>
              )}

              {!isLoading && (
                <div className="p-5 text-center border-t border-line">
                  <span className="text-sm text-ink-muted font-body">
                    Showing {filteredEmployees.length} of {employees.length} employees
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
