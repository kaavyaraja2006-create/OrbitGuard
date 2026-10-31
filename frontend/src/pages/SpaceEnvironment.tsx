import { GlobeViewer } from "../components/GlobeViewer";
import { ObjectInspector } from "../components/ObjectInspector";
import { TimelineControls } from "../components/TimelineControls";
import { TrackingPanel } from "../components/TrackingPanel";
import { useApp } from "../stores/app";

export function SpaceEnvironment() {
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  return (
    <div className="-m-3 flex h-[calc(100%+1.5rem)] flex-col sm:-m-5 sm:h-[calc(100%+2.5rem)]">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <TrackingPanel />
        <div className="relative min-h-[360px] min-w-0 flex-1">
          <div className="absolute inset-0">
            <GlobeViewer className="h-full w-full rounded-none" tracking />
          </div>
          {selectedId !== null && (
            <div className="absolute right-0 top-0 z-20 h-full w-full max-w-[420px] border-l border-line bg-sidebar/95 backdrop-blur">
              <ObjectInspector id={selectedId} variant="panel" onClose={() => select(null)} />
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-line-2 bg-app p-3">
        <TimelineControls />
      </div>
    </div>
  );
}
