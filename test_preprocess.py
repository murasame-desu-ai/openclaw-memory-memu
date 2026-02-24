"""Tests for preprocess_query in memu_wrapper."""
from memu_wrapper import preprocess_query


def test_removes_korean_stopwords():
    assert preprocess_query("그리고 메뮤 때문에 오류") == "메뮤 오류"


def test_removes_english_stopwords():
    assert preprocess_query("what is the memory about") == "memory"


def test_preserves_short_words():
    # "이" is a stopword and removed, but "세상" alone is 2 chars
    # so the fallback returns the original query
    assert preprocess_query("이 세상") == "이 세상"


def test_short_result_returns_original():
    # If result collapses to 2 chars or less, return original
    assert preprocess_query("이 가") == "이 가"


def test_mixed_korean_english():
    result = preprocess_query("엔트로픽의 Claude에서 사용")
    assert "엔트로픽의" in result
    assert "Claude에서" in result


def test_whitespace_cleanup():
    result = preprocess_query("  메뮤에서   검색을   ")
    assert "메뮤에서" in result
    assert "검색을" in result
    assert "  " not in result


def test_preserves_particles_on_words():
    """Particles attached to words should NOT be stripped."""
    assert preprocess_query("엔트로픽의 모델") == "엔트로픽의 모델"
    assert preprocess_query("메뮤에서 검색") == "메뮤에서 검색"
    assert preprocess_query("사용자가 저장") == "사용자가 저장"
