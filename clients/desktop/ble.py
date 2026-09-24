# BLE transport: runs bleak's asyncio loop on its own daemon thread and hands
# parsed samples to the Qt (main) thread through a plain thread-safe queue.
# See PLAN.md §4 for why this split exists and what it deliberately doesn't do
# (no MTU negotiation — macOS/CoreBluetooth already gives us plenty for 22
# bytes; no qasync — a second event loop isn't needed unless bleak ever
# proves it is).

from __future__ import annotations

import asyncio
import queue
import threading
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

from protocol import CHARACTERISTIC_UUID, DEVICE_NAME, SERVICE_UUID, Sample, parse_packet

# bleak 3.x removed BleakClient.get_rssi() (no backend-agnostic way to read
# RSSI from an active GATT connection). RSSI only exists in advertisement
# data, so it's captured once at scan time instead — see _find_device.

# States pushed to on_state. Plain strings, not an enum — this is the whole
# vocabulary and it isn't going to grow.
ST_SCANNING = "scanning"
ST_CONNECTED = "connected"
ST_DISCONNECTED = "disconnected"
ST_ERROR = "error"

SCAN_TIMEOUT_S = 10.0


class BleWorker:
    """Owns one background thread running one asyncio loop running one bleak
    connection. `on_state` is called from that background thread — the Qt
    side must marshal it back via a signal, never touch widgets directly."""

    def __init__(self, on_state: Callable[[str, str], None]):
        self.on_state = on_state
        self.queue: "queue.SimpleQueue[Sample]" = queue.SimpleQueue()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event: Optional[asyncio.Event] = None
        self.rssi: Optional[int] = None
        self.malformed = 0  # notifies that didn't parse as a valid VBT packet

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._loop is not None and self._stop_event is not None:
            self._loop.call_soon_threadsafe(self._stop_event.set)

    # -- background thread ---------------------------------------------

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._stop_event = asyncio.Event()
        try:
            self._loop.run_until_complete(self._connect_and_stream())
        except Exception as exc:  # noqa: BLE001 — surface anything to the UI
            self.on_state(ST_ERROR, str(exc))
        finally:
            self._loop.close()

    async def _connect_and_stream(self) -> None:
        self.on_state(ST_SCANNING, "")
        device = await self._find_device()
        if device is None:
            self.on_state(ST_ERROR, f"'{DEVICE_NAME}' not found after {SCAN_TIMEOUT_S:.0f}s scan")
            return

        def on_disconnect(_client: BleakClient) -> None:
            self.on_state(ST_DISCONNECTED, "")

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            await client.start_notify(CHARACTERISTIC_UUID, self._on_notify)
            self.on_state(ST_CONNECTED, device.name or DEVICE_NAME)

            await self._stop_event.wait()
            await client.stop_notify(CHARACTERISTIC_UUID)

    async def _find_device(self) -> Optional[BLEDevice]:
        # One scan, matched by name OR by advertised service UUID (covers a
        # firmware rename without touching this file) — and it's the only
        # place RSSI is available in bleak 3.x, so grab it here too.
        found = await BleakScanner.discover(timeout=SCAN_TIMEOUT_S, return_adv=True)
        for device, adv in found.values():
            name_matches = device.name == DEVICE_NAME
            service_matches = SERVICE_UUID.lower() in (u.lower() for u in adv.service_uuids)
            if name_matches or service_matches:
                self.rssi = adv.rssi
                return device
        return None

    def _on_notify(self, _sender, data: bytearray) -> None:
        # Parse here, on the BLE thread — it's ~200ns, not worth a hop.
        # Malformed notifies never reach the queue, so this counter is the
        # only place they're visible at all — count it right here.
        sample = parse_packet(bytes(data))
        if sample is not None:
            self.queue.put(sample)
        else:
            self.malformed += 1
