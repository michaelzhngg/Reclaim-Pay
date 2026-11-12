import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** Frame for the signed-out pages beside login: forgot, set and reset password. */
export default function AuthShell({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center bg-marshmallow px-4 py-8 sm:px-8">
      <div className="flex w-full max-w-[440px] items-center">
        <Link href="/login" className="flex items-center gap-2 rounded-full">
          <Image src="/images/logo.svg" alt="" width={26} height={26} className="h-[26px] w-[26px]" priority />
          <span className="font-headline text-[19px] font-semibold tracking-[-0.03em] text-on-surface" translate="no">
            Reclaim <span className="text-paypal-blue">Pay</span>
          </span>
        </Link>
      </div>

      <div className="my-auto w-full max-w-[440px] py-10">
        <div className="rounded-dialog bg-surface p-5 shadow-ambient-lg sm:p-8">
          <h1 className="font-headline text-[26px] font-semibold leading-tight tracking-[-0.03em] text-on-surface sm:text-[30px]">
            {title}
          </h1>
          {intro && <div className="mt-1.5 text-[15px] text-on-surface-variant">{intro}</div>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
