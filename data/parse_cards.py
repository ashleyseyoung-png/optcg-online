#!/usr/bin/env python3
"""Parse raw pipe-delimited One Piece TCG card dumps into a clean cards.json."""
import json
import re
import glob
import os

RAW_DIR = os.path.join(os.path.dirname(__file__), "raw")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "public", "data", "cards.json")

FIELDS = ["card_set_id", "card_name", "card_type", "card_color", "card_cost",
          "card_power", "counter_amount", "life", "attribute", "rarity",
          "sub_types", "card_text"]

NULLS = {"-", "—", "‐", "−", "NULL", "null", "", "None"}

ART_SUFFIX_RE = re.compile(
    r"\s*\((Alternate Art|Parallel|Box Topper|Manga|Full Art|Reprint)\)\s*$", re.I)
ID_SUFFIX_RE = re.compile(r"_(p|r)\d+$", re.I)
NAME_SET_SUFFIX_RE = re.compile(r"\s*-\s*(OP\d{2}|ST\d{2}|EB\d{2})-\d{3}\s*$")  # "Perona - OP14-111"
NAME_PAREN_ID_RE = re.compile(r"\s*\((?:OP\d{2}|ST\d{2}|EB\d{2})?-?\d{3}\)\s*$")  # trailing (073) style — keep, these disambiguate real different cards

# Curated supplement to the auto-mined known-type-phrase list (see build below),
# covering common OPTCG traits that don't happen to appear in "[X] type" form in card text.
CURATED_TYPES = [
    "Straw Hat Crew", "Worst Generation", "Supernovas", "Heart Pirates", "Kid Pirates",
    "Beautiful Pirates", "Big Mom Pirates", "Homies", "The Sun Pirates", "Fish-Man",
    "Fish-Man Island", "Arlong Pirates", "Baroque Works", "The Seven Warlords of the Sea",
    "Navy", "CP9", "CP0", "World Government", "Revolutionary Army", "Whitebeard Pirates",
    "The Four Emperors", "Red-Haired Pirates", "Former Roger Pirates", "Rocks Pirates",
    "Blackbeard Pirates", "Animal Kingdom Pirates", "The Akazaya Nine", "Land of Wano",
    "Kouzuki Clan", "Kurozumi Clan", "Minks", "Sky Island", "Shandian Warrior", "Giant",
    "Impel Down", "Alabasta", "Dressrosa", "Donquixote Pirates", "Thriller Bark Pirates",
    "Kuja Pirates", "Fish-Man Karate", "Foxy Pirates", "Drum Kingdom", "Water Seven",
    "Galley-La Company", "FILM", "ODYSSEY", "Egghead", "Scientist", "The Vinsmoke Family",
    "GERMA 66", "Buggy Pirates", "Buggy's Delivery", "Cross Guild", "Animal", "Special",
    "Biological Weapon", "SMILE", "Firetank Pirates", "Hawkins Pirates", "Fallen Monk Pirates",
    "Barto Club Pirates", "On-Air Pirates", "Drake Pirates", "Bonney Pirates", "Franky Family",
    "East Blue", "Windmill Village", "Goa Kingdom", "Frost Moon Village", "Muggy Kingdom",
    "Bowin Island", "Merfolk", "New Giant Pirate Crew", "Sniper Island", "Neo Navy",
    "Golden Lion Pirates", "Grantesoro", "The Pirates Fest", "Music", "Jailer Beast",
    "Whitebeard Pirates Allies", "Former Whitebeard Pirates", "Former Navy",
    "Former Baroque Works", "Navy SWORD", "Mountain Bandits", "Celestial Dragons",
    "Firetank Pirates", "Animal Kingdom", "Kid Pirates Supernovas", "Charlotte Family",
    "Fish-Man Pirates", "New Fishman Pirates", "Ryugu Kingdom", "Cross Guild",
]


def clean(v):
    v = v.strip()
    return None if v in NULLS else v


def to_int(v):
    v = clean(v)
    if v is None:
        return None
    v = v.replace(",", "").strip()
    try:
        return int(v)
    except ValueError:
        m = re.search(r"-?\d+", v)
        return int(m.group()) if m else None


def normalize_id(raw_id):
    return ID_SUFFIX_RE.sub("", raw_id.strip())


def normalize_name(name):
    name = ART_SUFFIX_RE.sub("", name).strip()
    name = NAME_SET_SUFFIX_RE.sub("", name).strip()
    return name


def parse_line(line, source_file):
    parts = line.split("|", 11)
    if len(parts) < 12:
        return None
    rec = dict(zip(FIELDS, parts))
    raw_id = rec["card_set_id"].strip()
    if not raw_id or " " in raw_id and not raw_id.startswith("P-"):
        pass
    base_id = normalize_id(raw_id)
    name = normalize_name(clean(rec["card_name"]) or "")
    ctype = clean(rec["card_type"]) or "Character"
    colors = (clean(rec["card_color"]) or "").split()
    cost = to_int(rec["card_cost"])
    power = to_int(rec["card_power"])
    counter = to_int(rec["counter_amount"])
    life = to_int(rec["life"])
    attribute = clean(rec["attribute"])
    rarity = clean(rec["rarity"])
    sub_types = (clean(rec["sub_types"]) or "")
    types = [t for t in sub_types.split() if t] if sub_types else []
    text = clean(rec["card_text"]) or ""
    text = text.replace("\\n", "\n")

    is_alt = bool(ART_SUFFIX_RE.search(rec["card_name"])) or raw_id != base_id

    # crude keyword extraction for the rules engine
    keywords = []
    for kw in ["Rush", "Blocker", "Double Attack", "Banish", "Trigger"]:
        if f"[{kw}]" in text:
            keywords.append(kw)

    return {
        "id": base_id,
        "name": name or base_id,
        "type": ctype,
        "colors": colors,
        "cost": cost,
        "power": power,
        "counter": counter,
        "life": life,
        "attribute": attribute,
        "rarity": rarity,
        "types": types,
        "text": text,
        "keywords": keywords,
        "set": base_id.split("-")[0] if "-" in base_id else base_id,
        "image": f"https://optcgapi.com/media/static/Card_Images/{base_id}.jpg",
        "_is_alt": is_alt,
        "_source": source_file,
    }


def build_known_types(all_text):
    mined = set(re.findall(r"[\[{\"]([A-Za-z0-9 .'\-]{3,40}?)[\]}\"]\s*type", all_text))
    known = set(CURATED_TYPES) | mined
    # longest phrase first so greedy matching prefers full multi-word types
    return sorted(known, key=lambda s: -len(s.split()))


def segment_types(sub_types_str, known_sorted):
    if not sub_types_str:
        return []
    words = sub_types_str.split()
    result = []
    pending = []
    i = 0
    n = len(words)
    while i < n:
        matched = None
        for phrase in known_sorted:
            pw = phrase.split()
            L = len(pw)
            if L <= n - i and [w.lower() for w in words[i:i + L]] == [w.lower() for w in pw]:
                matched = phrase
                i += L
                break
        if matched:
            if pending:
                result.append(" ".join(pending))
                pending = []
            result.append(matched)
        else:
            pending.append(words[i])
            i += 1
    if pending:
        result.append(" ".join(pending))
    return result


def main():
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.txt")))
    cards_by_id = {}
    dupe_count = 0
    skipped = 0
    total_lines = 0
    for fp in files:
        with open(fp, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                if line.startswith("###"):
                    continue
                if line.strip() in ("FETCH_FAILED",):
                    continue
                total_lines += 1
                card = parse_line(line, os.path.basename(fp))
                if card is None:
                    skipped += 1
                    continue
                cid = card["id"]
                if cid in cards_by_id:
                    dupe_count += 1
                    existing = cards_by_id[cid]
                    # prefer the non-alt-art / shorter-name version as canonical
                    if existing["_is_alt"] and not card["_is_alt"]:
                        cards_by_id[cid] = card
                    continue
                cards_by_id[cid] = card

    cards = list(cards_by_id.values())
    all_text = " ".join(c["text"] for c in cards)
    known_sorted = build_known_types(all_text)
    for c in cards:
        del c["_is_alt"]
        raw_sub = None
        # re-derive from source line isn't stored; use existing crude split joined back
        raw_sub = " ".join(c["types"])
        c["types"] = segment_types(raw_sub, known_sorted)
        del c["_source"]
    cards.sort(key=lambda c: c["id"])

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(cards, f, ensure_ascii=False, indent=1)

    by_type = {}
    for c in cards:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1

    print(f"Parsed {total_lines} raw lines from {len(files)} files")
    print(f"Skipped (malformed): {skipped}")
    print(f"Duplicate ids merged: {dupe_count}")
    print(f"Unique cards written: {len(cards)}")
    print("By type:", by_type)
    print("Output:", OUT_PATH)


if __name__ == "__main__":
    main()
