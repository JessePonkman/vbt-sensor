#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <NimBLEDevice.h>

// ============================================================
// I2C
// ============================================================

#define SDA_PIN 8
#define SCL_PIN 9

#define MPU6050_ADDRESS 0x68

// Fast Mode. The MPU6050 supports 400 kHz per datasheet, and the default
// Wire.begin(sda, scl) passes frequency = 0, which the ESP32 HAL turns into
// 100 kHz. One getEvent() is a 14-byte burst read plus addressing, ~17 bytes
// at 9 bits each: ~1.5 ms at 100 kHz against a 10 ms sample budget. At
// 400 kHz it drops to ~0.4 ms. That recovered time is the single biggest
// reduction in sampling jitter available here, and `jitterUs` in the packet
// is what proves it.
#define I2C_CLOCK_HZ 400000


// ============================================================
// BLE
// ============================================================

#define BLE_DEVICE_NAME "VBT-ESP32"

#define SERVICE_UUID \
    "4fafc201-1fb5-459e-8fcc-c5c9c331914b"

#define CHARACTERISTIC_UUID \
    "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// Connection interval, in units of 1.25 ms: 6..12 = 7.5..15 ms.
//
// Nothing negotiated this before, so Android and macOS were free to settle
// on their defaults (typically 30-50 ms). At 100 Hz that means 3-5 notifies
// have to be queued per connection event, which is what made packets arrive
// in bursts and, once the TX queue filled, disappear. At 15 ms we need 2 per
// event, and NimBLE queues comfortably more than that.
#define CONN_INTERVAL_MIN 6
#define CONN_INTERVAL_MAX 12

// Never skip a connection event: at 100 Hz there is always data pending.
#define CONN_LATENCY 0

// Supervision timeout in units of 10 ms = 4 s.
#define CONN_TIMEOUT 400

// 42-byte packet + 3-byte ATT header fits in the 23-byte default only if we
// ask for more. The mobile client already requests 247; asking from this
// side too means the link does not depend on the client remembering to.
#define REQUESTED_MTU 247


// ============================================================
// VBT PROTOCOL
// ============================================================

// Protocol identifier
#define VBT_MAGIC 0x56

// Protocol version
//
// v2 adds the gyroscope and temperature the driver was already reading and
// discarding, a flags byte, and honest sample timing. See firmware/PLAN.md.
//
// This is a breaking change: clients/mobile/src/protocol.ts still rejects
// anything that is not 0x01 and will receive nothing until it dispatches on
// the version byte the way clients/desktop/protocol.py now does.
#define VBT_VERSION 0x02


// Flags — mirrored as FLAG_* in clients/desktop/protocol.py.

// An accelerometer axis sat on the +-8 g rail. A clipped sample is a hard
// truncation, and no low-pass filter repairs one — it smears it. Marking it
// is the only way the desktop tool can tell a railed reading from a large
// legitimate one.
#define VBT_FLAG_ACCEL_CLIPPED 0x01

// Same, for the gyroscope's +-500 dps rail.
#define VBT_FLAG_GYRO_CLIPPED 0x02

// mpu.getEvent() returned false. The sensors_event_t structs still hold
// whatever the previous read left in them, so the values in this packet are
// stale. v1 discarded this return value and shipped stale data as if it were
// real, which made I2C glitches indistinguishable from genuine spikes.
#define VBT_FLAG_IMU_READ_FAILED 0x04

// The read finished a full sample interval or more behind its slot.
#define VBT_FLAG_SCHED_LATE 0x08

// The scheduler gave up catching up and jumped to now — see the resync
// guard in loop().
#define VBT_FLAG_SCHED_RESYNC 0x10


// Clip thresholds, at 99% of full scale because the exact rail depends on
// each part's sensitivity trim.
//
//   MPU6050_RANGE_8_G     -> 8 g   * 9.80665       = 78.45 m/s^2
//   MPU6050_RANGE_500_DEG -> 500 dps in rad/s      =  8.727 rad/s
#define ACCEL_CLIP_MS2 77.67f
#define GYRO_CLIP_RADS 8.639f


// ============================================================
// CONFIGURATION
// ============================================================

// Target acquisition frequency.
//
// 100 Hz = 10 ms
// 200 Hz = 5 ms
//
// We start with 100 Hz for the prototype.
#define SAMPLE_INTERVAL_US 10000

// How far behind schedule we tolerate before abandoning catch-up.
//
// Must stay equal to DT_MAX_S in clients/desktop/dsp.py (0.25 s): that is
// where the client cuts the capture into a new segment rather than
// interpolate across the hole. Both ends agreeing on "too far behind" is
// what keeps the firmware's idea of a discontinuity and the client's
// identical. Change one, change the other.
#define MAX_CATCHUP_US 250000

// How many packets to skip between Serial debug lines.
//
// At 100 Hz, printing every packet costs ~6.2 ms per line at 115200 baud —
// 62% of the 10 ms budget — and Serial.print() blocks once the UART TX
// buffer fills, dragging the real sample rate down. Print 1 in N instead.
// 0 disables serial debug printing entirely.
#define SERIAL_DEBUG_EVERY 50


// ============================================================
// SENSOR
// ============================================================

Adafruit_MPU6050 mpu;


// ============================================================
// BLE
// ============================================================

NimBLEServer* pServer = nullptr;

NimBLECharacteristic* pCharacteristic = nullptr;


// ============================================================
// SAMPLE COUNTER
// ============================================================

uint32_t sequenceNumber = 0;

// Loop scheduling. File-scope (not `static` inside loop()) so setup() can
// seed it after its ~2.5s of delay() calls — otherwise the first loop() sees
// micros() ~= 3,000,000 against a lastSampleTime of 0 and fires a ~300-packet
// catch-up burst at SAMPLE_INTERVAL_US = 10000 (harmless at the old 1 Hz, but
// it poisons the very first second of any 100 Hz session).
uint32_t lastSampleTime = 0;

// Notifies dropped since the last successful one, saturating at 255.
//
// Rides in the NEXT packet that makes it out — a dropped packet obviously
// cannot report its own loss. That lets the client separate two failures
// that look identical from the outside: a gap of N with txDropped == N was
// backpressure inside the ESP32, a gap of N with txDropped == 0 was lost
// over the air.
uint8_t txDropped = 0;


// ============================================================
// PACKET
// ============================================================
//
// VBT Protocol v2
//
// Byte 0       : magic       uint8    (0x56)
// Byte 1       : version     uint8    (0x02)
// Byte 2       : flags       uint8    VBT_FLAG_* bitfield
// Byte 3       : txDropped   uint8
// Byte 4-7     : timestamp   uint32   scheduled grid time, us since boot
// Byte 8-11    : sequence    uint32
// Byte 12-13   : jitterUs    int16    actual read time minus scheduled
// Byte 14-25   : accel X/Y/Z float32  m/s^2
// Byte 26-37   : gyro  X/Y/Z float32  rad/s
// Byte 38-41   : tempC       float32  degrees Celsius
//
// TOTAL = 42 bytes
//
// magic and version stay at offset 0 and 1 so that version dispatch on the
// client only ever has to read two bytes, however much the rest grows.
//
// ============================================================

#pragma pack(push, 1)

struct VBTDataPacket {

    uint8_t magic;

    uint8_t version;

    uint8_t flags;

    uint8_t txDropped;

    uint32_t timestamp;

    uint32_t sequence;

    int16_t jitterUs;

    float accelX;
    float accelY;
    float accelZ;

    float gyroX;
    float gyroY;
    float gyroZ;

    float tempC;
};

#pragma pack(pop)


// Make sure the packet is exactly 42 bytes.
//
// If this fails, the compiler inserted unexpected padding.
static_assert(
    sizeof(VBTDataPacket) == 42,
    "VBTDataPacket must be exactly 42 bytes"
);


// ============================================================
// SERIAL SETUP
// ============================================================

void setupSerial() {

    Serial.begin(115200);

    delay(2000);

    Serial.println();
    Serial.println("======================================");
    Serial.println("VBT ESP32");
    Serial.println("Protocol version: 2");
    Serial.println("======================================");
}


// ============================================================
// MPU6050 SETUP
// ============================================================

bool setupMPU6050() {

    Serial.println("Initializing I2C...");

    Wire.begin(
        SDA_PIN,
        SCL_PIN,
        I2C_CLOCK_HZ
    );

    delay(500);

    Serial.println("Initializing MPU6050...");

    if (!mpu.begin(
            MPU6050_ADDRESS,
            &Wire
        )) {

        Serial.println(
            "ERROR: MPU6050 initialization failed!"
        );

        return false;
    }

    Serial.println(
        "MPU6050 initialized successfully!"
    );


    // --------------------------------------------------------
    // Accelerometer
    // --------------------------------------------------------

    mpu.setAccelerometerRange(
        MPU6050_RANGE_8_G
    );


    // --------------------------------------------------------
    // Gyroscope
    //
    // Now carried in the VBT packet. It was always being read —
    // Adafruit_MPU6050::_read() pulls accel, temperature and gyro in one
    // 14-byte burst — so transmitting it costs no extra I2C time at all.
    // --------------------------------------------------------

    mpu.setGyroRange(
        MPU6050_RANGE_500_DEG
    );


    // --------------------------------------------------------
    // Digital Low Pass Filter
    // --------------------------------------------------------

    mpu.setFilterBandwidth(
        MPU6050_BAND_21_HZ
    );


    Serial.println(
        "MPU6050 configuration complete."
    );

    return true;
}


// ============================================================
// BLE SERVER CALLBACKS
// ============================================================

class VBTServerCallbacks : public NimBLEServerCallbacks {

    void onConnect(
        NimBLEServer* server,
        NimBLEConnInfo& connInfo
    ) override {

        // Anything left over from the previous session is not this
        // client's loss to hear about.
        txDropped = 0;

        server->updateConnParams(
            connInfo.getConnHandle(),
            CONN_INTERVAL_MIN,
            CONN_INTERVAL_MAX,
            CONN_LATENCY,
            CONN_TIMEOUT
        );

        Serial.println(
            "Client connected."
        );
    }


    void onDisconnect(
        NimBLEServer* server,
        NimBLEConnInfo& connInfo,
        int reason
    ) override {

        Serial.print(
            "Client disconnected, reason="
        );

        Serial.println(
            reason
        );
    }
};


// ============================================================
// BLE SETUP
// ============================================================

void setupBLE() {

    Serial.println();
    Serial.println("Initializing BLE...");


    // Initialize BLE
    NimBLEDevice::init(
        BLE_DEVICE_NAME
    );

    NimBLEDevice::setMTU(
        REQUESTED_MTU
    );


    // Create server
    pServer =
        NimBLEDevice::createServer();

    pServer->setCallbacks(
        new VBTServerCallbacks()
    );


    // NimBLE defaults this to false, and nothing else turns it back on, so
    // without this line the ESP32 stops advertising the moment a client
    // disconnects and needs a power-cycle before it can be found again.
    pServer->advertiseOnDisconnect(
        true
    );


    // Create service
    NimBLEService* pService =
        pServer->createService(
            SERVICE_UUID
        );


    // Create characteristic
    pCharacteristic =
        pService->createCharacteristic(
            CHARACTERISTIC_UUID,

            NIMBLE_PROPERTY::READ |
            NIMBLE_PROPERTY::NOTIFY
        );

    // Configure advertising
    NimBLEAdvertising* pAdvertising =
        NimBLEDevice::getAdvertising();

    pAdvertising->addServiceUUID(
        SERVICE_UUID
    );

    pAdvertising->setName(
        BLE_DEVICE_NAME
    );

    // A hint carried in the advertisement. updateConnParams() in onConnect
    // is the explicit request after the fact; host stacks honour one or the
    // other depending on version, so we send both.
    pAdvertising->setPreferredParams(
        CONN_INTERVAL_MIN,
        CONN_INTERVAL_MAX
    );


    // Start advertising.
    //
    // This also starts the GATT server: NimBLEAdvertising::start() calls
    // pServer->start() before it advertises.
    pAdvertising->start();


    Serial.println(
        "BLE initialized successfully."
    );

    Serial.print(
        "Device name: "
    );

    Serial.println(
        BLE_DEVICE_NAME
    );

    Serial.println(
        "Waiting for BLE connection..."
    );
}


// ============================================================
// CREATE SENSOR PACKET
// ============================================================
//
// `scheduledUs` is the slot this sample belongs to, not the moment it was
// taken. See the timestamp/jitter comment below.
//
// ============================================================

VBTDataPacket createPacket(
    uint32_t scheduledUs
) {

    sensors_event_t acceleration;
    sensors_event_t gyro;
    sensors_event_t temperature;


    VBTDataPacket packet;

    packet.flags = 0;


    // Read MPU6050.
    //
    // On failure the three events keep their previous contents. We send the
    // sample anyway — skipping it would put a hole in the sequence and lie
    // about the cadence — but flagged, so the client can drop or median it
    // instead of mistaking stale values for a real spike.

    if (!mpu.getEvent(
            &acceleration,
            &gyro,
            &temperature
        )) {

        packet.flags |=
            VBT_FLAG_IMU_READ_FAILED;
    }


    // Protocol metadata

    packet.magic =
        VBT_MAGIC;

    packet.version =
        VBT_VERSION;


    // Timing
    //
    // timestamp is the SCHEDULED time, not micros(). The scheduler
    // accumulates (lastSampleTime += SAMPLE_INTERVAL_US) rather than
    // reassigning, so every timestamp is an exact multiple of the interval
    // since the seed — which is precisely the uniform grid that
    // clients/desktop/dsp.py needs to justify fixed-coefficient filters.
    // v1 sent micros() read after the I2C transaction finished, so it
    // carried the bus latency and never actually had that property.
    //
    // jitterUs keeps that honest. A synthetic grid with no measure of how
    // far reality drifted from it looks perfect and can still be wrong, so
    // we ship the deviation alongside the claim.

    packet.timestamp =
        scheduledUs;

    // Both operands are uint32, so the subtraction wraps correctly; the
    // cast then reads it as signed. Saturate into int16: +-32.7 ms covers
    // anything short of a stall, and a stall raises SCHED_RESYNC anyway.
    int32_t jitter =
        (int32_t)(micros() - scheduledUs);

    packet.jitterUs =
        (int16_t)constrain(jitter, -32768, 32767);

    if (jitter >= (int32_t)SAMPLE_INTERVAL_US) {

        packet.flags |=
            VBT_FLAG_SCHED_LATE;
    }


    // Acceleration

    packet.accelX =
        acceleration.acceleration.x;

    packet.accelY =
        acceleration.acceleration.y;

    packet.accelZ =
        acceleration.acceleration.z;


    // Angular velocity — rad/s, as sensors_event_t reports it

    packet.gyroX =
        gyro.gyro.x;

    packet.gyroY =
        gyro.gyro.y;

    packet.gyroZ =
        gyro.gyro.z;


    // Temperature
    //
    // Not decoration: the dominant error in double integration is DC bias,
    // and the MPU6050's bias drifts with temperature while the chip
    // self-heats over the first minutes of a session. Logging it is what
    // lets the desktop tool measure that correlation instead of guess at it.

    packet.tempC =
        temperature.temperature;


    // Full-scale detection

    if (fabsf(packet.accelX) >= ACCEL_CLIP_MS2 ||
        fabsf(packet.accelY) >= ACCEL_CLIP_MS2 ||
        fabsf(packet.accelZ) >= ACCEL_CLIP_MS2) {

        packet.flags |=
            VBT_FLAG_ACCEL_CLIPPED;
    }

    if (fabsf(packet.gyroX) >= GYRO_CLIP_RADS ||
        fabsf(packet.gyroY) >= GYRO_CLIP_RADS ||
        fabsf(packet.gyroZ) >= GYRO_CLIP_RADS) {

        packet.flags |=
            VBT_FLAG_GYRO_CLIPPED;
    }


    // Bookkeeping

    packet.txDropped =
        txDropped;

    packet.sequence =
        sequenceNumber++;


    return packet;
}


// ============================================================
// SEND PACKET VIA BLE
// ============================================================

void sendBLEPacket(
    const VBTDataPacket& packet
) {

    if (pCharacteristic == nullptr ||
        pServer == nullptr) {
        return;
    }


    // With no one subscribed there is nothing to drop. Counting these would
    // saturate txDropped at 255 while idle and make the first packet of
    // every session report a loss that never happened.

    if (pServer->getConnectedCount() == 0) {
        return;
    }


    // Send raw binary packet.
    //
    // The characteristic contains exactly
    // sizeof(VBTDataPacket) bytes.

    pCharacteristic->setValue(
        reinterpret_cast<
            const uint8_t*
        >(&packet),

        sizeof(VBTDataPacket)
    );


    // Notify connected client.
    //
    // notify() returns false when NimBLE's TX queue is full. v1 discarded
    // that, so backpressure inside the ESP32 was invisible and looked
    // exactly like radio loss.

    if (pCharacteristic->notify()) {

        txDropped = 0;

    } else if (txDropped < 255) {

        txDropped++;
    }
}


// ============================================================
// SERIAL DEBUG
// ============================================================
//
// printf rather than a chain of Serial.print() calls: this line now carries
// twelve fields, and the budget note on SERIAL_DEBUG_EVERY above is the
// reason to format it once instead of flushing two dozen times.
//
// The diagnostic fields only print when they are non-zero, which in a
// healthy session is never — so the common line stays short.
//
// ============================================================

void printSerialPacket(
    const VBTDataPacket& packet
) {

    Serial.printf(
        "SEQ=%lu | TIME=%lu us | A=%.3f %.3f %.3f m/s^2 | G=%.3f %.3f %.3f rad/s | T=%.2f C",
        (unsigned long)packet.sequence,
        (unsigned long)packet.timestamp,
        packet.accelX,
        packet.accelY,
        packet.accelZ,
        packet.gyroX,
        packet.gyroY,
        packet.gyroZ,
        packet.tempC
    );

    if (packet.jitterUs != 0) {

        Serial.printf(
            " | JITTER=%d us",
            (int)packet.jitterUs
        );
    }

    if (packet.flags != 0) {

        Serial.printf(
            " | FLAGS=0x%02X",
            packet.flags
        );
    }

    if (packet.txDropped != 0) {

        Serial.printf(
            " | TXDROP=%u",
            (unsigned)packet.txDropped
        );
    }

    Serial.println();
}


// ============================================================
// SETUP
// ============================================================

void setup() {

    setupSerial();


    // Initialize MPU6050

    if (!setupMPU6050()) {

        Serial.println();
        Serial.println(
            "System halted."
        );

        while (true) {
            delay(1000);
        }
    }


    // Initialize BLE

    setupBLE();


    // Seed the sample scheduler *after* the delay()s above, not at global
    // construction time — see the comment on lastSampleTime.
    lastSampleTime = micros();


    Serial.println();
    Serial.println(
        "======================================"
    );

    Serial.println(
        "SYSTEM READY"
    );

    Serial.print(
        "Sampling frequency: "
    );

    Serial.print(
        1000000.0 / SAMPLE_INTERVAL_US
    );

    Serial.println(
        " Hz"
    );

    Serial.println(
        "Packet size: 42 bytes"
    );

    Serial.println(
        "======================================"
    );

    Serial.println();
}


// ============================================================
// LOOP
// ============================================================

void loop() {

    uint32_t now = micros();


    // Check if it is time for another sample

    if (
        (uint32_t)(
            now - lastSampleTime
        ) >= SAMPLE_INTERVAL_US
    ) {

        uint8_t resyncFlag = 0;


        // ----------------------------------------------------
        // Resync guard
        //
        // The note on lastSampleTime describes this hazard at boot and
        // solves it by seeding late. The same thing can happen while
        // running — a BLE stack stall, an I2C bus hang — and there is no
        // setup() to reseed us then. Advancing one interval per loop
        // would fire a catch-up burst of however many slots we missed,
        // all carrying timestamps from the past.
        //
        // Past MAX_CATCHUP_US, jump the schedule to now and mark the
        // discontinuity instead.
        // ----------------------------------------------------

        if (
            (uint32_t)(
                now - lastSampleTime
            ) > MAX_CATCHUP_US
        ) {

            lastSampleTime = now;

            resyncFlag =
                VBT_FLAG_SCHED_RESYNC;
        }


        uint32_t scheduledUs = lastSampleTime;

        lastSampleTime +=
            SAMPLE_INTERVAL_US;


        // ----------------------------------------------------
        // Read sensor and create packet
        // ----------------------------------------------------

        VBTDataPacket packet =
            createPacket(scheduledUs);

        packet.flags |= resyncFlag;


        // ----------------------------------------------------
        // Serial debugging — 1 in SERIAL_DEBUG_EVERY packets only
        // ----------------------------------------------------

        if (
            SERIAL_DEBUG_EVERY &&
            packet.sequence % SERIAL_DEBUG_EVERY == 0
        ) {
            printSerialPacket(
                packet
            );
        }


        // ----------------------------------------------------
        // BLE
        // ----------------------------------------------------

        sendBLEPacket(
            packet
        );
    }
}
