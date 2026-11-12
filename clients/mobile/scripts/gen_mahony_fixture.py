"""Generates src/fixtures/mahony_ref.json: a slice of a real recording (from
clients/desktop/sessions) run through the reference Mahony in
clients/desktop/imu.py. src/orientation.test.ts requires the TypeScript port to
reproduce it, so the two implementations cannot silently drift apart.

    python3 -I scripts/gen_mahony_fixture.py
"""
import csv
import json
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
desktop = here.parents[1] / "desktop"
sys.path.insert(0, str(desktop))

import imu  # noqa: E402

SESSION = desktop / "sessions" / "2026-09-25_163821.csv"
N = 500
KP, KI, G_REF = 1.0, 0.05, 9.81

rows = list(csv.DictReader(open(SESSION)))[:N]
acc = [[float(r["ax"]), float(r["ay"]), float(r["az"])] for r in rows]
gyr = [[float(r["gx"]), float(r["gy"]), float(r["gz"])] for r in rows]

q0 = list(imu.tilt_quat(*acc[0]))  # imu.py's own start point; see tiltQuat in orientation.ts
st = imu.MahonyState(q=tuple(q0))
quats = []
for (ax, ay, az), (gx, gy, gz) in zip(acc, gyr):
    imu.mahony_step(st, gx, gy, gz, ax, ay, az, 0.01, KP, KI, G_REF, reject=True)
    quats.append(list(st.q))

out = {
    "source": "clients/desktop/sessions/" + SESSION.name + " (first %d samples)" % N,
    "fs": 100.0,
    "params": {"kp": KP, "ki": KI, "gRef": G_REF, "tolMag": imu.ACC_REJECT_TOL_MAG_DEFAULT, "tolAngDeg": imu.ACC_REJECT_TOL_ANG_DEFAULT},
    "q0": q0,
    "acc": acc,
    "gyr": gyr,
    "quats": quats,
}
dest = here.parent / "src" / "fixtures" / "mahony_ref.json"
dest.write_text(json.dumps(out, separators=(",", ":")))
print("wrote", dest, len(rows), "samples")
