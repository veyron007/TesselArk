"""Copy the researched feature register into a compact UI-readable catalogue."""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "research/consolidated/feature-register.csv"
OUTPUT = ROOT / "src/data/features.json"

with SOURCE.open(newline="", encoding="utf-8-sig") as source:
    rows = list(csv.DictReader(source))

features = [
    {
        "id": row["id"],
        "domain": row["domain"],
        "capability": row["capability"],
        "workflow": row["concrete_workflow"],
        "acceptance": row["acceptance_example"],
    }
    for row in rows
]
if len(features) != 85 or len({feature["id"] for feature in features}) != 85:
    raise SystemExit("Expected 85 unique feature groups in research register")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(features, indent=2, ensure_ascii=False) + "\n")
print(f"Synced {len(features)} feature groups to {OUTPUT.relative_to(ROOT)}")
