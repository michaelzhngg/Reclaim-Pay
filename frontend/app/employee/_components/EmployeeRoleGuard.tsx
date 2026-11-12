"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { isPersonalPortalRole } from "@/lib/roles";

export default function EmployeeRoleGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!isPersonalPortalRole(user.role)) {
      router.replace("/hr/dashboard");
    }
  }, [user, isLoading, router]);

  if (isLoading || !user || !isPersonalPortalRole(user.role)) return null;

  return <>{children}</>;
}
