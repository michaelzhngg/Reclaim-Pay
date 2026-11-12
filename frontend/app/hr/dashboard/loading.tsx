// Matches the queue-first dashboard: title, one summary line, tabs, then rows.
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6 md:px-8 md:py-8" aria-busy="true" aria-label="Loading claims queue">
      <div className="h-8 w-48 rounded-control bg-surface-muted animate-pulse" />
      <div className="mt-2 h-4 w-72 max-w-full rounded-control bg-surface-muted animate-pulse" />
      <div className="mt-6 h-11 w-full max-w-xl rounded-control bg-surface-muted animate-pulse" />
      <div className="mt-4 flex flex-col gap-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-[52px] rounded-control bg-surface-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}
