import sys
from pathlib import Path

SCRIPT_FOLDER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_FOLDER))

from vf import pull

SQL = "SELECT 1 AS replace_this_with_the_question"
ORG = "pronghorn"
DESTINATION = SCRIPT_FOLDER / "raw_pulls" / "step1_pull.parquet"

pull(SQL, DESTINATION, org=ORG)
