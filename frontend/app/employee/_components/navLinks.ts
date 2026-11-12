import {
  LayoutDashboard,
  FileText,
  History,
  CalendarDays,
  ClipboardList,
  Settings,
  LifeBuoy,
  BriefcaseBusiness,
} from "lucide-react";
import type { NavLink } from "@/components/shell/types";

export const EMPLOYEE_LINKS: NavLink[] = [
  { href: "/employee/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employee/claims", label: "Upload Claim", icon: FileText },
  { href: "/employee/bookings", label: "Book Vendor", icon: BriefcaseBusiness },
  { href: "/employee/history", label: "History", icon: History },
  { href: "/employee/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/employee/drafts", label: "Drafts", icon: ClipboardList },
  { href: "/employee/settings", label: "Settings", icon: Settings },
];

/**
 * A contractor sees their own money records only. Bookings, drafts, the calendar and
 * every company-wide surface stay out of the nav.
 */
export const CONTRACTOR_LINKS: NavLink[] = [
  { href: "/employee/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/employee/claims", label: "Claims", icon: FileText },
  { href: "/employee/history", label: "History", icon: History },
  { href: "/employee/settings", label: "Settings", icon: Settings },
];

/** Drawer (mobile): the pages that are not in the bottom tab bar. */
export const EMPLOYEE_DRAWER_LINKS: NavLink[] = [
  { href: "/employee/bookings", label: "Book Vendor", icon: BriefcaseBusiness },
  { href: "/employee/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/employee/settings", label: "Settings", icon: Settings },
  { href: "/employee/support", label: "Support", icon: LifeBuoy },
];

export const CONTRACTOR_DRAWER_LINKS: NavLink[] = [
  { href: "/employee/settings", label: "Settings", icon: Settings },
  { href: "/employee/support", label: "Support", icon: LifeBuoy },
];

export function navLinksForRole(role: string | null | undefined): NavLink[] {
  return role === "Contractor" ? CONTRACTOR_LINKS : EMPLOYEE_LINKS;
}

export function drawerLinksForRole(role: string | null | undefined): NavLink[] {
  return role === "Contractor" ? CONTRACTOR_DRAWER_LINKS : EMPLOYEE_DRAWER_LINKS;
}
