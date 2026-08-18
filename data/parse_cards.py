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

# Any trailing "(...)" that describes a PRINTING rather than the card: alt arts, parallels,
# manga/full art, box toppers, SP/SPR, promo events ("Gift Collection 2023"), winner packs...
ART_SUFFIX_RE = re.compile(
    r"\s*\((Alternate Art|Parallel|Box Topper|Manga|Manga Art|Full Art|Reprint|SP|SPR|Special|Wanted Poster|Treasure Rare|Winner[^)]*|[^)]*(Pack|Collection|Tournament|Championship|Edition|Event|Promo|Release|Festival|Fest\.?|Cup|Regional|Store|Anniversary|Gift|Set|Vol\.?)[^)]*)\)\s*$", re.I)
ID_SUFFIX_RE = re.compile(r"_(p|r|pr|alt|v)\d+$", re.I)
NAME_SET_SUFFIX_RE = re.compile(r"\s*(?:-\s*|\(\s*)(OP\d{2}|ST\d{2}|EB\d{2}|PRB\d{2}|P)-\d{3}\s*\)?\s*$")  # "Perona - OP14-111", "Zoro (ST32-005)"
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


BRACKET_SUFFIX_RE = re.compile(r"\s*\[([^\]]{1,40})\]\s*$")  # "... [Winner]"


def normalize_name(name):
    for _ in range(3):  # peel "(Alternate Art) [Winner]"-style stacks
        name = BRACKET_SUFFIX_RE.sub("", name).strip()
        name = ART_SUFFIX_RE.sub("", name).strip()
    name = NAME_SET_SUFFIX_RE.sub("", name).strip()
    # "Monkey.D.Luffy (010)" — the source data appends card numbers to disambiguate; official
    # names don't have them (and effect text refers to plain names), so strip them for display.
    name = NAME_PAREN_ID_RE.sub("", name).strip()
    return name


def variant_label(raw_name, raw_id, base_id):
    """Human label for a printing: 'Alternate Art', 'Parallel', 'Gift Collection 2023 · Winner', ..."""
    labels = []
    name = raw_name
    for _ in range(3):
        m = BRACKET_SUFFIX_RE.search(name)
        if m:
            labels.insert(0, m.group(1).strip()); name = BRACKET_SUFFIX_RE.sub("", name).strip(); continue
        m = ART_SUFFIX_RE.search(name)
        if m:
            labels.insert(0, m.group(1).strip()); name = ART_SUFFIX_RE.sub("", name).strip(); continue
        break
    if labels:
        return " · ".join(labels)
    if raw_id != base_id:
        return "Alternate Art"
    return None


RARITY_CODES = {"C", "UC", "R", "SR", "SEC", "L", "SP", "TR", "P", "PR"}


def repair_shifted_row(parts):
    """A handful of raw rows (OP13/OP15 leaders, OP08-039) carry one extra field so rarity/types/text
    land one slot to the right. Detect (rarity code sitting in the types slot) and put the values back
    where the normal layout expects them. Verified against the API for OP13-002, OP15-001, OP15-058, OP08-039."""
    if len(parts) < 13 or parts[10].strip() not in RARITY_CODES or parts[9].strip() in RARITY_CODES or parts[12].startswith("http"):
        return parts
    ctype = parts[2].strip()
    def num(v):
        v = v.strip()
        return int(v) if re.fullmatch(r"-?\d+", v) else None
    if ctype == "Leader":
        # OP13 shape: life|-|-|-|power|attr|L|types|text ; OP15 shape: -|5|-|0|life|attr|L|types|text (power in thousands)
        vals = [num(parts[i]) for i in range(4, 9)]
        power = next((v for v in vals if v is not None and v >= 1000), None)
        if power is None:
            small = num(parts[5])
            power = small * 1000 if small is not None and 0 < small < 100 else None
        life = num(parts[4]) if num(parts[4]) is not None and num(parts[4]) <= 10 else (num(parts[8]) if num(parts[8]) is not None and num(parts[8]) <= 10 else None)
        cost, counter = "-", "-"
        attribute = parts[9].strip() if parts[9].strip() not in NULLS and num(parts[9]) is None and parts[9].strip() != "?" else "-"
        fixed = [parts[0], parts[1], parts[2], parts[3], cost, str(power) if power is not None else "-", counter, str(life) if life is not None else "-", attribute, parts[10], parts[11], parts[12]] + parts[13:]
        return fixed
    # non-leader (e.g. OP08-039 Zou): cost|power|counter|life|attr|<extra>|rarity|types|text
    fixed = [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7], parts[8], parts[10], parts[11], parts[12]] + parts[13:]
    return fixed


def parse_line(line, source_file):
    parts = line.split("|", 13)
    if len(parts) < 12:
        return None
    parts = repair_shifted_row(parts)
    rec = dict(zip(FIELDS, parts[:12]))
    image_field = clean(parts[12]) if len(parts) > 12 else None
    setid_field = clean(parts[13]) if len(parts) > 13 else None
    raw_id = rec["card_set_id"].strip()
    if not raw_id or raw_id in NULLS:
        return None
    # promo lines carry the real card number in the 14th field; the 1st is the printing id
    base_id = normalize_id(setid_field) if setid_field else normalize_id(raw_id)
    raw_name = clean(rec["card_name"]) or ""
    name = normalize_name(raw_name)
    variant = variant_label(raw_name, raw_id, base_id)
    ctype = clean(rec["card_type"]) or "Character"
    colors = (clean(rec["card_color"]) or "").split()
    cost = to_int(rec["card_cost"])
    power = to_int(rec["card_power"])
    counter = to_int(rec["counter_amount"])
    life = to_int(rec["life"])
    attribute = clean(rec["attribute"])
    rarity = clean(rec["rarity"])
    if ctype == "Leader":
        rarity = "L"
    elif rarity not in RARITY_CODES:
        rarity = None
    sub_types = (clean(rec["sub_types"]) or "")
    types = [t for t in sub_types.split() if t] if sub_types else []
    text = clean(rec["card_text"]) or ""
    text = text.replace("\\n", "\n")

    is_alt = variant is not None

    keywords = []
    for kw in ["Rush", "Blocker", "Double Attack", "Banish", "Trigger"]:
        if f"[{kw}]" in text:
            keywords.append(kw)

    # printing id: base for the plain card, base_pN / base_prN etc. for other printings
    pid = raw_id if raw_id.startswith(base_id) else (base_id if not is_alt else f"{base_id}_{raw_id}")
    if is_alt and pid == base_id:
        pid = f"{base_id}_v"  # will be de-collided in main()

    # image: explicit URL from the API when we have one; otherwise the standard pattern
    if image_field and image_field.lower().startswith("http"):
        image = image_field
    elif base_id.startswith("P-"):
        image = f"https://en.onepiece-cardgame.com/images/cardlist/card/{base_id}.png"
    else:
        image = f"https://optcgapi.com/media/static/Card_Images/{pid}.jpg"
    # official Bandai card list as a second source (base card + _pN alt arts exist there too)
    image2 = f"https://en.onepiece-cardgame.com/images/cardlist/card/{pid if pid == base_id or ID_SUFFIX_RE.search(pid) else base_id}.png"

    set_code = base_id.split("-")[0] if "-" in base_id else base_id
    return {
        "id": pid,
        "baseId": base_id,
        "name": name or base_id,
        "variant": variant,
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
        "set": set_code,
        "image": image,
        "image2": image2,
        "_is_alt": is_alt,
        "_has_img": bool(image_field and image_field.lower().startswith("http")),
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
                if not line.strip() or line.startswith("###") or line.strip() == "FETCH_FAILED":
                    continue
                total_lines += 1
                card = parse_line(line, os.path.basename(fp))
                if card is None:
                    skipped += 1
                    continue
                cid = card["id"]
                if cid.endswith("_v"):
                    # same id reused for a different printing (e.g. ST29 base + Parallel): make unique
                    n = 2
                    while f"{card['baseId']}_v{n}" in cards_by_id:
                        n += 1
                    cid = f"{card['baseId']}_v{n}"
                    card["id"] = cid
                    card["image"] = card["image"] if card["_has_img"] else f"https://optcgapi.com/media/static/Card_Images/{card['baseId']}.jpg"
                if cid in cards_by_id:
                    dupe_count += 1
                    existing = cards_by_id[cid]
                    # keep the record with the most information (explicit image / longer text)
                    if (card["_has_img"] and not existing["_has_img"]) or (len(card["text"]) > len(existing["text"]) and not existing["_has_img"]):
                        cards_by_id[cid] = card
                    continue
                cards_by_id[cid] = card

    # Alt printings that came from dumps without a distinct image id ("_vN" placeholders): both
    # optcgapi and the official card list publish alt arts as {base}_p1, {base}_p2, ... in
    # release order, so give each one the next free _pN slot for its base. If an explicit _pN
    # row already exists for that slot, the placeholder is the same printing -> merge into it.
    by_base = {}
    for c in cards_by_id.values():
        by_base.setdefault(c["baseId"], []).append(c)
    for base_id, group in by_base.items():
        taken = {c["id"] for c in group}
        placeholders = sorted((c for c in group if re.search(r"_v\d+$", c["id"])), key=lambda c: int(c["id"].rsplit("_v", 1)[1]))
        n = 1
        for c in placeholders:
            while f"{base_id}_p{n}" in taken:
                n += 1
            del cards_by_id[c["id"]]
            new_id = f"{base_id}_p{n}"
            c["id"] = new_id
            if not c["_has_img"]:
                c["image"] = f"https://optcgapi.com/media/static/Card_Images/{new_id}.jpg"
            c["image2"] = f"https://en.onepiece-cardgame.com/images/cardlist/card/{new_id}.png"
            cards_by_id[new_id] = c
            taken.add(new_id)
            n += 1

    # every printing must have a base card to hang off; synthesize one from the first printing if missing
    bases = {c["baseId"] for c in cards_by_id.values() if c["id"] == c["baseId"]}
    for c in list(cards_by_id.values()):
        if c["baseId"] not in bases:
            base = dict(c)
            base["id"] = c["baseId"]
            base["variant"] = None
            base["_is_alt"] = False
            base["image"] = f"https://optcgapi.com/media/static/Card_Images/{c['baseId']}.jpg" if not c["_has_img"] else c["image"]
            base["image2"] = f"https://en.onepiece-cardgame.com/images/cardlist/card/{c['baseId']}.png"
            cards_by_id[c["baseId"]] = base
            bases.add(c["baseId"])

    # A printing is the same card as its base by rule: inherit the base's game data so a
    # data slip on an alt-art row can never make it play differently.
    base_by_id = {c["baseId"]: c for c in cards_by_id.values() if c["id"] == c["baseId"]}
    for c in cards_by_id.values():
        if c["id"] != c["baseId"]:
            b = base_by_id[c["baseId"]]
            for k in ("name", "type", "colors", "cost", "power", "counter", "life", "attribute", "types", "text", "keywords", "set"):
                c[k] = b[k]

    cards = list(cards_by_id.values())
    all_text = " ".join(c["text"] for c in cards)
    known_sorted = build_known_types(all_text)
    for c in cards:
        c["types"] = segment_types(" ".join(c["types"]), known_sorted)
        for k in ("_is_alt", "_has_img", "_source"):
            c.pop(k, None)
    cards.sort(key=lambda c: (c["baseId"], c["id"] != c["baseId"], c["id"]))

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(cards, f, ensure_ascii=False, indent=1)

    by_type = {}
    for c in cards:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1
    n_base = sum(1 for c in cards if c["id"] == c["baseId"])
    print(f"Parsed {total_lines} raw lines from {len(files)} files")
    print(f"Skipped (malformed): {skipped}")
    print(f"Duplicate printings merged: {dupe_count}")
    print(f"Printings written: {len(cards)}  (base cards: {n_base}, alt/promo printings: {len(cards) - n_base})")
    print("By type:", by_type)
    print("Output:", OUT_PATH)


if __name__ == "__main__":
    main()
