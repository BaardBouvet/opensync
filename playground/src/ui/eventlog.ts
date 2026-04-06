// Event log — timestamped feed of engine sync actions at the bottom of the right pane.
import type { SyncEvent } from "../engine-lifecycle.js";

export function createEventLog(container: HTMLElement): {
  append: (ev: SyncEvent) => void;
  clear: () => void;
} {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "eventlog-header";
  header.innerHTML = `<span>Event log</span><button class="btn-ghost" id="log-clear">Clear</button>`;
  container.appendChild(header);

  const list = document.createElement("div");
  list.className = "eventlog-list";
  container.appendChild(list);

  container.querySelector("#log-clear")!.addEventListener("click", () => clear());

  let count = 0;

  function append(ev: SyncEvent): void {
    count++;
    if (count > 500) {
      list.firstChild?.remove();
    }
    const row = document.createElement("div");
    row.className = `log-row log-${ev.action.toLowerCase()}`;
    // Format: ts  src→tgt  ACTION  entity  srcId… → tgtId…
    row.textContent =
      `${ev.ts}  ${ev.sourceConnector}→${ev.targetConnector}  ` +
      `${ev.action.padEnd(6)}  ${ev.sourceEntity}  ` +
      `${ev.sourceId}… → ${ev.targetId}…`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  function clear(): void {
    list.innerHTML = "";
    count = 0;
  }

  return { append, clear };
}
