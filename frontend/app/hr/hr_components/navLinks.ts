import {
  LayoutDashboard,
  FileSliders,
  History,
  Settings,
  LifeBuoy,
  Users,
  Banknote,
  Gauge,
  FileBarChart,
  BadgeCheck,
} from "lucide-react";
import type { NavLink } from "@/components/shell/types";

export const HR_LINKS: NavLink[] = [
  { href: "/hr/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/hr/policy", label: "Policy Studio", icon: FileSliders },
  { href: "/hr/manage_employee", label: "Employees", icon: Users },
  { href: "/hr/contractors", label: "Contractors", icon: BadgeCheck },
  { href: "/hr/history", label: "History", icon: History },
  { href: "/hr/payouts", label: "Payouts", icon: Banknote },
  { href: "/hr/reports", label: "Reports", icon: FileBarChart },
  { href: "/hr/autonomy", label: "Autonomy", icon: Gauge },
  { href: "/hr/settings", label: "Settings", icon: Settings },
];

/** Drawer (mobile): the pages that are not in the bottom tab bar. */
export const HR_DRAWER_LINKS: NavLink[] = [
  { href: "/hr/manage_employee", label: "Employees", icon: Users },
  { href: "/hr/autonomy", label: "Autonomy", icon: Gauge },
  { href: "/hr/reports", label: "Reports", icon: FileBarChart },
  { href: "/hr/settings", label: "Settings", icon: Settings },
  { href: "/hr/support", label: "Support", icon: LifeBuoy },
];
