"use client";

import SidebarNav from "@/components/shell/SidebarNav";
import { HR_LINKS } from "./navLinks";

export default function SideNav() {
  return <SidebarNav portal="HR" supportHref="/hr/support" links={HR_LINKS} />;
}
