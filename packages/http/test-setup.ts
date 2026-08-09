import { initLogger } from "evlog";

// Keep the wide-event pipeline enabled — the helpers read c.get("log") — but
// send every event nowhere and print nothing.
initLogger({ drain: () => Promise.resolve(), silent: true });
