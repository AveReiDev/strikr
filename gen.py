import json, re

RAW = {
("muaythai","beginner"): """Jab - Cross
Jab - Cross - Lead hook
Jab - Cross - Rear body kick
Jab - Rear low kick
Lead teep - Cross
Jab - Lead hook - Rear low kick
Double jab - Cross
Cross - Lead hook - Cross
Rear teep - Jab - Cross
Jab - Cross - Rear straight knee""",

("muaythai","intermediate"): """Jab - Cross - Lead hook - Rear body kick
Jab - Switch body kick
Jab - Cross - Rear horizontal elbow
Lead teep - Cross - Lead hook - Rear low kick
Jab - Rear uppercut - Lead hook - Rear low kick
Cross - Lead hook - Switch kick
Jab - Cross - Lead body kick - Rear body kick
Jab feint - Rear low kick - Cross
Jab - Cross - Clinch entry - Rear knee - Frame off
Catch teep - Cross - Rear body kick""",

("muaythai","advanced"): """Jab - Cross - Lead hook - Spinning rear elbow
Question mark kick - Cross - Lead hook
Jab - Cross - Rear body kick - (land switched) - Cross - Lead hook
Teep feint - Switch kick - Cross - Rear horizontal elbow
Jab - Rear uppercut - Lead up-elbow - Rear knee
Cross - Lead hook - Rear low kick - Spinning back fist
Long guard entry - Rear elbow - Clinch - Lead knee - Rear knee - Turn and dump
Check rear low kick - Cross - Lead hook - Rear body kick
Catch rear kick - Sweep - Cross
Step-up knee - Cross - Lead elbow - Rear body kick""",

("boxing","beginner"): """Jab - Cross
Jab - Jab - Cross
Jab - Cross - Lead hook
Jab - Cross - Lead hook - Cross
Jab - Rear uppercut
Jab - Cross - Rear uppercut
Lead hook - Cross
Jab to body - Cross to head
Cross - Lead hook
Jab - Cross - Lead hook to body""",

("boxing","intermediate"): """Jab - Cross - Lead hook - Rear uppercut
Jab - Slip outside - Cross - Lead hook
Jab - Cross to body - Cross to head
Lead uppercut - Lead hook - Cross
Jab - Cross - Roll under - Lead hook - Cross
Double jab - Cross - Lead hook to body
Jab - Rear uppercut - Lead hook - Cross
Cross - Lead hook - Cross - Lead hook to body
Jab - Pivot lead - Lead hook - Cross
Jab feint - Step in - Rear uppercut - Lead hook""",

("boxing","advanced"): """Jab - Cross - Roll under - Lead hook to body - Lead hook to head - Cross
Double jab - Cross - Slip outside - Lead uppercut - Cross - Lead hook
Jab - Cross - Lead hook - Pivot out - Cross
Lead hook to body - Lead hook to head - Cross - Rear uppercut
Check hook off the jab - Cross - Lead hook
Jab - Rear uppercut - Lead hook - Cross - Roll - Lead hook
Lead shovel hook to body - Rear uppercut - Lead hook
Jab to body - Slip - Cross - Lead hook - Rear uppercut
Cross feint - Lead hook to body - Cross - Pivot
Long jab - Step back - Pull counter cross - Lead hook""",

("kickboxing","beginner"): """Jab - Cross - Rear low kick
Jab - Cross - Lead hook - Rear low kick
Jab - Rear body kick
Lead teep - Cross
Cross - Lead hook - Rear low kick
Jab - Cross - Lead hook - Cross
Jab - Lead low kick
Rear low kick - Cross
Jab - Cross - Rear uppercut - Lead hook
Double jab - Rear body kick""",

("kickboxing","intermediate"): """Jab - Cross - Lead hook - Rear body kick
Jab - Cross - Rear uppercut - Lead hook - Rear low kick
Lead teep - Jab - Cross - Rear low kick
Jab - Cross - Roll under - Lead hook - Rear low kick
Cross - Lead hook - Cross - Switch body kick
Jab - Rear low kick - Lead hook - Rear body kick
Jab - Cross - Lead hook to body - Rear high kick
Rear low kick - Cross - Lead hook - Rear low kick
Jab - Cross - Rear knee - Lead hook
Lead hook - Cross - Switch low kick""",

("kickboxing","advanced"): """Jab - Cross - Lead hook - Rear uppercut - Lead hook - Rear low kick
Jab - Cross - Roll under - Lead hook - Cross - Rear high kick
Rear low kick - Cross - Lead hook - Switch body kick - Cross
Jab - Cross - Lead hook - Spinning back kick
Question mark kick - Cross - Lead hook - Rear low kick
Jab - Cross - Rear body kick - (land switched) - Cross - Lead hook - Rear low kick
Teep feint - Jab - Cross - Rear uppercut - Switch high kick
Cross - Lead hook - Rear uppercut - Lead hook - Spinning back fist - Rear low kick
Check the low kick - Cross - Lead hook - Rear body kick
Jab - Cross - Lead knee - Lead hook - Rear low kick""",
}

PREFIX = {"muaythai":"mt","boxing":"bx","kickboxing":"kb"}
combos = []
for (sport, tier), block in RAW.items():
    for i, line in enumerate(block.strip().split("\n"), 1):
        segs = [s.strip() for s in line.split(" - ")]
        spoken = [s for s in segs if not s.startswith("(")]
        combos.append({
            "id": f"{PREFIX[sport]}-{tier[:3]}-{i:02d}",
            "sport": sport,
            "tier": tier,
            "display": " – ".join(segs),
            "speech": ", ".join(spoken),
            "actions": len(segs),
            "frequency": "common",
            "enabled": True,
            "custom": False,
        })

out = {"schemaVersion": 1, "combos": combos}
with open("combos.json","w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

# verification
from collections import Counter
print("total combos:", len(combos))
print(Counter((c["sport"], c["tier"]) for c in combos))
print("ids unique:", len(set(c["id"] for c in combos)) == len(combos))
print("action count range:", min(c["actions"] for c in combos), "-", max(c["actions"] for c in combos))
print("parenthetical combos:", [c["id"] for c in combos if "(" in c["display"]])
for c in combos:
    if "(" in c["speech"]: print("LEAK", c["id"])
print("\nsample:")
for c in combos[:2] + [x for x in combos if "(" in x["display"]][:1]:
    print(json.dumps(c, ensure_ascii=False))
