from pathlib import Path
import runpy

root = Path(__file__).resolve().parent
for step in sorted((root / "steps").glob("step*.py")):
    runpy.run_path(str(step), run_name="__main__")
