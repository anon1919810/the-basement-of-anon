"""T2 单元测试：会话令牌 / API Key 加解密 / 密码哈希 / 邀请码配置。

纯本地测试，不触网。运行：`python test_core.py`（在 backend/ 目录下）。
"""

from app import config as cfg
from app import database as db
from app import env

_passed = 0
_failed = []


def check(name, cond):
    global _passed
    if cond:
        _passed += 1
        print(f"[PASS] {name}")
    else:
        _failed.append(name)
        print(f"[FAIL] {name}")


# ---------- 会话令牌（HMAC，24h） ----------
tok = db.create_session_token("42")
check("生成令牌格式 payload.mac", bool(tok) and "." in tok)
check("正常令牌校验通过", db.validate_session_token(tok) == "42")
bad = tok[:-2] + ("xx" if tok[-2:] != "xx" else "yy")
check("篡改令牌被拒绝", db.validate_session_token(bad) is None)
check("空令牌被拒绝", db.validate_session_token("") is None)
check("过期令牌被拒绝", db.validate_session_token(db.create_session_token("42", hours=-1)) is None)

# ---------- API Key 加密（XOR+SHA256流） ----------
enc = db._encrypt_key("sk-test-abc-123")
check("密文非空且不等于明文", bool(enc) and enc != "sk-test-abc-123")
check("解密还原明文", db._decrypt_key(enc) == "sk-test-abc-123")
check("中文Key往返稳定", db._decrypt_key(db._encrypt_key("中文密钥测试")) == "中文密钥测试")

# ---------- 密码哈希（加盐，兼容旧版） ----------
import hashlib

h = db.hash_password("mima123")
check("加盐哈希含$分隔符", "$" in h)
check("正确密码校验通过", db.verify_password("mima123", h))
check("错误密码被拒绝", not db.verify_password("wrong", h))
legacy = hashlib.sha256("oldpass".encode("utf-8")).hexdigest()
check("旧版无盐哈希兼容", db.verify_password("oldpass", legacy))

# ---------- 邀请码 / 管理名单配置 ----------
check("邀请码已配置且为 931226", env.INVITE_CODE == "931226")
check("管理员名单可解析", isinstance(env.ADMIN_USERNAMES, set) and len(env.ADMIN_USERNAMES) >= 1)
check("调参常量与生产一致（VERSION）", cfg.VERSION == "5.1.0")
check("调参常量与生产一致（EXTRACTION_PASSES）", cfg.EXTRACTION_PASSES == 3)

if _failed:
    print(f"\nFAILED {len(_failed)}: {_failed}")
    raise SystemExit(1)
print(f"\nALL PASS ({_passed} checks)")
