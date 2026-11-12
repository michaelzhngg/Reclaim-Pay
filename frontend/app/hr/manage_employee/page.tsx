"use client";

import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Users,
  Search,
  Plus,
  Pencil,
  MoreVertical,
  Mail,
  Building2,
  X,
} from "lucide-react";
import { getEmployees, type EmployeeRecord } from "@/lib/actions/employees";

// ─── Sub-components ──────────────────────────────────────────────────────────

function EmployeeModal({
  isOpen,
  onClose,
  employee
}: {
  isOpen: boolean;
  onClose: () => void;
  employee?: EmployeeRecord | null;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Escape closes the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  const isEdit = !!employee;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-ink/40 cursor-default"
        onClick={onClose}
      />

      {/* Modal */}
      <div role="dialog" aria-modal="true" aria-labelledby="employee-modal-title" className="relative w-full max-w-2xl bg-surface rounded-dialog border border-line shadow-overlay overflow-hidden">
        <div className="px-5 sm:px-8 py-4 sm:py-5 border-b border-line flex items-center justify-between gap-3">
          <div>
            <h3 id="employee-modal-title" className="font-display font-semibold text-xl text-ink">
              {isEdit ? "Edit Employee" : "Add Employee"}
            </h3>
            <p className="text-xs text-ink-muted mt-1">
              {isEdit ? `Modifying details for ${employee.name}` : "Fill in the details to register a new member."}
            </p>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="Close"
            className="inline-flex items-center justify-center w-11 h-11 shrink-0 rounded-control hover:bg-surface-muted transition-colors cursor-pointer"
          >
            <X className="w-5 h-5 text-ink-muted" aria-hidden="true" />
          </button>
        </div>

        <form className="p-5 sm:p-8 overflow-y-auto max-h-[70dvh] custom-scrollbar" onSubmit={(e) => { e.preventDefault(); onClose(); }}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            {/* Basic Info */}
            <div className="space-y-4 md:col-span-2">
               <h4 className="text-sm font-semibold text-ink border-b border-line pb-1">Primary Information</h4>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Full Name</label>
              <input type="text" defaultValue={employee?.name} placeholder="e.g. John Doe" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" required />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Company ID</label>
              <input type="text" defaultValue={employee?.user_code ?? ""} placeholder="e.g. EMP-12345" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" required />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Company Email</label>
              <input type="email" defaultValue={employee?.email} placeholder="john.doe@reclaim.my" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" required />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Contact Number</label>
              <input type="tel" placeholder="+60 12-345 6789" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" />
            </div>

            {/* Employment */}
            <div className="space-y-4 md:col-span-2 mt-4">
               <h4 className="text-sm font-semibold text-ink border-b border-line pb-1">Organization & Access</h4>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Department</label>
              <input type="text" defaultValue={employee?.department_name ?? ""} placeholder="e.g. Human Resources" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">System Role</label>
              <select defaultValue={employee?.role ?? "Employee"} className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm appearance-none cursor-pointer">
                <option value="Employee">Employee</option>
                <option value="HR">HR Admin</option>
              </select>
            </div>

            {/* Financial Info */}
            <div className="space-y-4 md:col-span-2 mt-4">
               <h4 className="text-sm font-semibold text-ink border-b border-line pb-1">Payment Details (for Reimbursements)</h4>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Bank Code</label>
              <input type="text" defaultValue={employee?.bank_code ?? ""} placeholder="e.g. MBBEMYKL" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Bank Account Number</label>
              <input type="text" defaultValue={employee?.bank_account_number ?? ""} placeholder="Enter account number" className="w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm" />
            </div>

          </div>

          <div className="mt-8 flex flex-col-reverse sm:flex-row gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-[44px] px-6 rounded-control border border-line-strong font-body font-semibold text-sm text-ink hover:bg-surface-muted transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-2 min-h-[44px] px-10 bg-accent text-on-accent rounded-full font-body font-semibold text-sm hover:bg-accent-hover transition-colors cursor-pointer"
            >
              {isEdit ? "Save Changes" : "Add Employee"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function ManageEmployeePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRecord | null>(null);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getEmployees().then((data) => {
      setEmployees(data);
      setIsLoading(false);
    }).catch(() => setIsLoading(false));
  }, []);

  const filteredEmployees = useMemo(() => {
    return employees.filter(emp =>
      emp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      emp.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (emp.department_name ?? "").toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, employees]);

  const handleCreate = () => {
    setSelectedEmployee(null);
    setIsModalOpen(true);
  };

  const handleEdit = (emp: EmployeeRecord) => {
    setSelectedEmployee(emp);
    setIsModalOpen(true);
  };

  const hrCount = employees.filter(e => e.role === "HR").length;

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div>
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
          <div className="max-w-2xl">
            <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Manage Employees</h1>
            <p className="mt-1 text-sm text-ink-muted">
              View, edit, and manage employee access and profiles.
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
            onClick={handleCreate}
            className="flex items-center justify-center gap-2 rounded-full min-h-[44px] px-5 bg-accent text-on-accent font-body text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Add Employee
          </button>
        </div>

        {/* Employee Modal (Create/Edit) */}
        <EmployeeModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          employee={selectedEmployee}
        />

        {/* Filter & Search Bar */}
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

        {/* Employee Table */}
        <div className="bg-surface shadow-ambient rounded-card overflow-hidden">
          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surface-muted">
                  <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Employee</th>
                  <th className="py-3 px-6 text-xs font-semibold text-ink-muted hidden md:table-cell">Department</th>
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
                  <tr key={emp.user_id} className="hover:bg-surface-muted transition-colors group">
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-surface-muted border border-line flex items-center justify-center font-semibold text-xs text-ink">
                          {emp.name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-ink">{emp.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Mail className="w-3 h-3 text-ink-muted" aria-hidden="true" />
                            <p className="text-xs text-ink-muted">{emp.email}</p>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6 hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <Building2 className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                        <p className="text-sm text-ink-muted">{emp.department_name ?? "Not set"}</p>
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        emp.role === "HR" ? "bg-warning-soft text-warning" : "bg-surface-muted text-ink"
                      }`}>
                        {emp.role}
                      </span>
                    </td>
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${emp.is_active ? "bg-success" : "bg-line-strong"}`} />
                        <p className={`text-xs font-medium ${emp.is_active ? "text-success" : "text-ink-muted"}`}>
                          {emp.is_active ? "Active" : "Inactive"}
                        </p>
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEdit(emp)}
                          type="button"
                          className="inline-flex items-center justify-center w-11 h-11 text-ink-muted hover:text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer"
                          aria-label={`Edit ${emp.name}`}
                          title="Edit Employee"
                        >
                          <Pencil className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`More actions for ${emp.name}`} className="inline-flex items-center justify-center w-11 h-11 text-ink-muted hover:text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer">
                          <MoreVertical className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Card List */}
          <div className="md:hidden flex flex-col divide-y divide-line">
            {isLoading ? (
              <div className="py-12 text-center text-ink-muted text-sm">Loading employees…</div>
            ) : filteredEmployees.map((emp) => (
              <div key={emp.user_id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
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
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                      emp.role === "HR" ? "bg-warning-soft text-warning" : "bg-surface-muted text-ink"
                    }`}>
                      {emp.role}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${emp.is_active ? "bg-success" : "bg-line-strong"}`} />
                      <p className={`text-xs font-medium ${emp.is_active ? "text-success" : "text-ink-muted"}`}>
                        {emp.is_active ? "Active" : "Inactive"}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-line">
                  <button
                    onClick={() => handleEdit(emp)}
                    type="button"
                    className="inline-flex items-center justify-center w-11 h-11 text-ink-muted hover:text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer"
                    aria-label={`Edit ${emp.name}`}
                    title="Edit Employee"
                  >
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`More actions for ${emp.name}`} className="inline-flex items-center justify-center w-11 h-11 text-ink-muted hover:text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer">
                    <MoreVertical className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!isLoading && filteredEmployees.length === 0 && (
            <div className="p-12 text-center">
              <Search className="w-8 h-8 mx-auto mb-3 text-ink-muted" aria-hidden="true" />
              <p className="font-display font-semibold text-lg text-ink">No employees found</p>
              <p className="text-ink-muted text-sm mt-1">Try adjusting your search or filters.</p>
            </div>
          )}

          {!isLoading && (
            <div className="p-5 text-center border-t border-line">
              <span className="text-sm text-ink-muted font-body">
                Showing {filteredEmployees.length} of {employees.length} employees
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
