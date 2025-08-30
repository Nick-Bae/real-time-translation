import re

_PARTICLE = re.compile(r"([은는이가을를도만에에서으로|로|에게|께|께서])$")
_CONNECTIVE = re.compile(r"(면$|는데$|지만$|려고$|거나$|니까$|면서$|고$)")
_REL_PRENOM = re.compile(r"(ㄴ$|은$|는$|던$|을$|ㄹ$)")
_PUNCT = re.compile(r"[.,!?…‥·、，]")
# backend/app/utils/hangul.py
_SAFE = re.compile(
    r"^(오늘|지금|잠시후|곧|여기서|이곳에서|예배(에|에서)?|기도(에|에서)?|설교(후|전)?|말씀(후|전)?|"
    r"환영합니다?|안내(를|에)?|광고(를|에)?|헌금|축도(후|전)?|찬양(후|전)?|다음은|"
    r"아침|오전|오후|저녁|밤|주일|이번주|다음주|금요일|토요일|주말)$"
)



def tokenize_ko(s: str) -> list[str]:
    s = re.sub(r"[\t\n]+", " ", s)
    s = re.sub(r"\s{2,}", " ", s)
    s = s.strip()
    return [t for t in s.split(" ") if t]


def is_safe_adverbial(tok: str) -> bool: return bool(_SAFE.match(tok))

def has_particle(tok: str) -> bool: return bool(_PARTICLE.search(tok))

def looks_connective(tok: str) -> bool: return bool(_CONNECTIVE.search(tok))

def looks_rel_prenom(tok: str) -> bool: return bool(_REL_PRENOM.search(tok))

def has_punct(s: str) -> bool: return bool(_PUNCT.search(s))