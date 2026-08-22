from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vf import pull

pull(
    sql="SELECT 1 AS replace_this_with_the_question",
    into=Path(__file__).resolve().parent.parent / "raw_pulls" / "step1_pull.parquet",
    script_name=Path(__file__).resolve().parent.parent.name,
)
