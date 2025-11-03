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


def test_clause_committer_handles_sticky_da_followed_by_common_adverbs():
    committer = ClauseCommitter(CommitConfig())
    text = "주님께 찬양합시다함께 예배합시다"
    emitted = committer.feed(text)
    assert emitted == "주님께 찬양합시다"
    remainder = committer.force_flush()
    assert remainder == "함께 예배합시다"

    committer.reset_for_new_utterance()

    text2 = "우리는 기도합시다같이 마음을 모읍시다"
    emitted2 = committer.feed(text2)
    assert emitted2 == "우리는 기도합시다"
    remainder2 = committer.force_flush()
    assert remainder2 == "같이 마음을 모읍시다"

    committer.reset_for_new_utterance()

    text3 = "오늘 말씀을 증언합시다 같이 나아갑시다"
    emitted3 = committer.feed(text3)
    assert emitted3 == "오늘 말씀을 증언합시다"
    remainder3 = committer.force_flush()
    assert remainder3 == "같이 나아갑시다"
