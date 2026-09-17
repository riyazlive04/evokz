/**
 * The campaign board while its one load runs on first entry: the header's shape
 * and seven empty day columns, so the page does not jump when the board arrives.
 *
 * Changing the filter, the search or the week keeps the board on screen instead
 * (the router navigates in a transition and the board dims while it loads).
 */
export default function CampaignBoardLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading the campaign board">
      <div className="space-y-3 border-b border-border pb-3">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-6 w-64 max-w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-80 max-w-full animate-pulse rounded bg-muted" />
        <div className="flex gap-1.5 overflow-hidden">
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index} className="h-8 w-24 shrink-0 animate-pulse rounded-full bg-muted" />
          ))}
        </div>
      </div>
      <ol className="-mx-4 flex gap-3 overflow-hidden px-4 sm:-mx-8 sm:px-8 xl:mx-0 xl:grid xl:grid-cols-7 xl:px-0">
        {Array.from({ length: 7 }, (_, index) => (
          <li key={index} className="w-[72vw] max-w-[15rem] shrink-0 space-y-2 rounded-lg border border-border p-2.5 sm:w-56 xl:w-auto xl:max-w-none">
            <div className="aspect-[3/4] animate-pulse rounded-md bg-muted" />
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ol>
    </div>
  );
}
