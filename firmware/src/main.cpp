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


// ============================================================
// BLE
// ============================================================

#define BLE_DEVICE_NAME "VBT-ESP32"

#define SERVICE_UUID \
    "4fafc201-1fb5-459e-8fcc-c5c9c331914b"

#define CHARACTERISTIC_UUID \
    "beb5483e-36e1-4688-b7f5-ea07361b26a8"


// ============================================================
// VBT PROTOCOL
// ============================================================

// Protocol identifier
#define VBT_MAGIC 0x56

// Protocol version
#define VBT_VERSION 0x01


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


// ============================================================
// PACKET
// ============================================================
//
// VBT Protocol v1
//
// Byte 0       : magic       uint8
// Byte 1       : version     uint8
// Byte 2-5     : timestamp   uint32
// Byte 6-9     : accel X     float32
// Byte 10-13   : accel Y     float32
// Byte 14-17   : accel Z     float32
// Byte 18-21   : sequence    uint32
//
// TOTAL = 22 bytes
//
// ============================================================

#pragma pack(push, 1)

struct VBTDataPacket {

    uint8_t magic;

    uint8_t version;

    uint32_t timestamp;

    float accelX;
    float accelY;
    float accelZ;

    uint32_t sequence;
};

#pragma pack(pop)


// Make sure the packet is exactly 22 bytes.
//
// If this fails, the compiler inserted unexpected padding.
static_assert(
    sizeof(VBTDataPacket) == 22,
    "VBTDataPacket must be exactly 22 bytes"
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
    Serial.println("Protocol version: 1");
    Serial.println("======================================");
}


// ============================================================
// MPU6050 SETUP
// ============================================================

bool setupMPU6050() {

    Serial.println("Initializing I2C...");

    Wire.begin(
        SDA_PIN,
        SCL_PIN
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
    // Not included in the VBT packet yet.
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
// BLE SETUP
// ============================================================

void setupBLE() {

    Serial.println();
    Serial.println("Initializing BLE...");


    // Initialize BLE
    NimBLEDevice::init(
        BLE_DEVICE_NAME
    );


    // Create server
    NimBLEServer* pServer =
        NimBLEDevice::createServer();


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


    // Start advertising
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

VBTDataPacket createPacket() {

    sensors_event_t acceleration;
    sensors_event_t gyro;
    sensors_event_t temperature;


    // Read MPU6050
    mpu.getEvent(
        &acceleration,
        &gyro,
        &temperature
    );


    VBTDataPacket packet;


    // Protocol metadata

    packet.magic =
        VBT_MAGIC;

    packet.version =
        VBT_VERSION;


    // Timestamp

    packet.timestamp =
        micros();


    // Acceleration

    packet.accelX =
        acceleration.acceleration.x;

    packet.accelY =
        acceleration.acceleration.y;

    packet.accelZ =
        acceleration.acceleration.z;


    // Sequence

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

    if (pCharacteristic == nullptr) {
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


    // Notify connected client

    pCharacteristic->notify();
}


// ============================================================
// SERIAL DEBUG
// ============================================================

void printSerialPacket(
    const VBTDataPacket& packet
) {

    Serial.print(
        "SEQ="
    );

    Serial.print(
        packet.sequence
    );


    Serial.print(
        " | TIME="
    );

    Serial.print(
        packet.timestamp
    );


    Serial.print(
        " us"
    );


    Serial.print(
        " | AX="
    );

    Serial.print(
        packet.accelX,
        3
    );


    Serial.print(
        " | AY="
    );

    Serial.print(
        packet.accelY,
        3
    );


    Serial.print(
        " | AZ="
    );

    Serial.print(
        packet.accelZ,
        3
    );


    Serial.println(
        " m/s^2"
    );
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
        "Packet size: 22 bytes"
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

        lastSampleTime +=
            SAMPLE_INTERVAL_US;


        // ----------------------------------------------------
        // Read sensor and create packet
        // ----------------------------------------------------

        VBTDataPacket packet =
            createPacket();


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