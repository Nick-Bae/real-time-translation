from backend.app.segmentation import ClauseCommitter, CommitConfig, KO_CONNECTIVE_HANGING_RE

def test_clause_committer_emits_sentence_endings():
    committer = ClauseCommitter(CommitConfig())
    sentence = "한국의 교회 다니는 50대 이하의 남자들의 1/3이 군대에서 세례를 받아요."
    emitted = committer.feed(sentence)
    assert emitted == sentence.strip()

def test_hanging_regex_does_not_match_empty_tail():
    assert KO_CONNECTIVE_HANGING_RE.search("") is None
    assert KO_CONNECTIVE_HANGING_RE.search("받아요") is None
    assert KO_CONNECTIVE_HANGING_RE.search("주님을 사랑하기 때문에") is not None


def test_partial_clause_with_particle_is_not_committed():
    committer = ClauseCommitter(CommitConfig())
    partial = "한국의 교회 다니는?"
    assert committer.feed(partial) is None

    full = "한국의 교회 다니는 50대 이하의 남자들의 1/3이 군대에서 세례를 받아요."
    assert committer.feed(full) == full.strip()


def test_subject_particle_suffix_waits_for_more_text():
    committer = ClauseCommitter(CommitConfig())
    fragment = "50대 이하의 남자들의."
    assert committer.feed(fragment) is None
