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

/** Drawer (mobile): the pages that are not in the bottom tab bar. */
export const EMPLOYEE_DRAWER_LINKS: NavLink[] = [
  { href: "/employee/bookings", label: "Book Vendor", icon: BriefcaseBusiness },
  { href: "/employee/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/employee/settings", label: "Settings", icon: Settings },
  { href: "/employee/support", label: "Support", icon: LifeBuoy },
];
