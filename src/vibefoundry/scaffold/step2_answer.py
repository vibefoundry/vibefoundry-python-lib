from pathlib import Path
import polars as pl

SCRIPT_FOLDER = Path(__file__).resolve().parent.parent
SOURCE = next(iter(sorted((SCRIPT_FOLDER / "raw_pulls").glob("*.parquet"))), None)
DESTINATION = SCRIPT_FOLDER / "final_output" / "answer.parquet"

if SOURCE is None:
    raise SystemExit("nothing in raw_pulls/ to answer from")

frame = pl.read_parquet(SOURCE)
DESTINATION.parent.mkdir(parents=True, exist_ok=True)
frame.write_parquet(DESTINATION)
print(frame)
