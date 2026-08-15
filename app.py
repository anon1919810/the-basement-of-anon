import database as db
import streamlit as st
import streamlit.components.v1 as components
import pandas as pd
import os
import time
import glob
import shutil
import re
import sys
import tempfile
from io import BytesIO

# ========== 调试：强制打印，确认 app.py 已加载 ==========
print("=== app.py 已加载（v4.5.0 车书万里）===", flush=True)
sys.stdout.flush()

# ========== 导入核心模块（加异常捕获） ==========
try:
    from extract_papers import extract_text_from_pdf, extract_cultural_elements, process_pdfs_parallel
    import extract_papers as extract_mod  # 用于运行期覆盖 OCR_DPI 等模块级参数
    print("✅ extract_papers 导入成功", flush=True)
except Exception as e:
    print(f"❌ extract_papers 导入失败：{e}", flush=True)
    st.error(f"核心模块导入失败：{e}")
    sys.exit(1)

try:
    from config import (
        CATEGORY_OPTIONS, BASIN_OPTIONS, VERSION, VERSION_TAG, APP_NAME,
        OUTPUT_BASE_NAME, DEFAULT_BOOK_NAME, FEW_SHOT_EXAMPLES,
        MAX_PARALLEL_WORKERS, ENABLE_CACHE, ENABLE_OCR, ENABLE_SPLIT,
        EXTRACTION_PASSES, OCR_DPI, EXTRACT_MAX_ONLY,
    )
    print("✅ config 导入成功", flush=True)
except Exception as e:
    print(f"❌ config 导入失败：{e}", flush=True)
    st.error(f"config 模块导入失败：{e}")
    sys.exit(1)

# ========== 检查 API Key ==========
try:
    import os
    from dotenv import load_dotenv
    load_dotenv()
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if api_key:
        print(f"✅ API Key 读取成功：{api_key[:10]}...", flush=True)
    else:
        print("❌ API Key 读取失败！请检查 Secrets 配置", flush=True)
except Exception as e:
    print(f"❌ API Key 检查出错：{e}", flush=True)

# ========== 权限与邀请码配置（可用环境变量覆盖，建议放 .env / 云端Secrets） ==========
# ADMIN_USERNAMES：管理员用户名（逗号分隔），默认作者
ADMIN_USERNAMES = [u.strip() for u in os.getenv("ADMIN_USERNAMES", "失败主义谋士千早爱音").split(",") if u.strip()]
# INVITE_CODE：邀请码（留空=关闭邀请机制）；用户填对后24小时内可用作者Key
INVITE_CODE = os.getenv("INVITE_CODE", "")
INVITE_VALID_HOURS = int(os.getenv("INVITE_VALID_HOURS", "24"))
# REQUIRE_KEY_OR_INVITE：True=非管理员用户必须自带Key或有效邀请码才能提取；
#                        False=回退旧行为（所有人用作者Key）
REQUIRE_KEY_OR_INVITE = os.getenv("REQUIRE_KEY_OR_INVITE", "true").lower() != "false"

# ========== 页面配置 ==========
st.set_page_config(page_title=APP_NAME, layout="wide", page_icon="📚")

# ========== UI 美化样式（Supabase 风格：白底 / 直角边框 / 简约细线条） ==========
st.markdown("""
<style>
    /* ---------- 全局 ---------- */
    html, body, [data-testid="stAppViewContainer"] {
        background-color: #fbfbfb !important;
        color: #1c1c1c !important;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif !important;
    }
    .block-container { max-width: 1100px !important; padding-top: 1.6rem !important; }

    /* ---------- 标题：紧凑、细字重 ---------- */
    h1 { font-size: 1.5rem !important; font-weight: 600 !important; color: #1c1c1c !important; letter-spacing: 0 !important; }
    h2, h3 { font-size: 1.08rem !important; font-weight: 600 !important; color: #1c1c1c !important; }
    .stCaption { color: #8a8f98 !important; font-size: 0.82rem !important; }

    /* ---------- 侧边栏：纯白 + 右侧1px细线 ---------- */
    section[data-testid="stSidebar"] {
        background-color: #ffffff !important;
        border-right: 1px solid #e8e8e8 !important;
    }
    section[data-testid="stSidebar"] hr { border-color: #f0f0f0 !important; }

    /* ---------- 折叠面板（Expander）：直角、细边框、可折叠 ---------- */
    [data-testid="stExpander"] {
        border: 1px solid #e6e6e6 !important;
        border-radius: 0px !important;
        background: #ffffff !important;
        box-shadow: none !important;
    }
    [data-testid="stExpander"] summary {
        border-radius: 0px !important;
        font-weight: 500 !important;
        color: #1c1c1c !important;
    }
    [data-testid="stExpander"] summary:hover { background: #f6f6f6 !important; }

    /* ---------- 按钮：白底细边框直角，主按钮用 Supabase 绿 ---------- */
    .stButton > button, .stDownloadButton > button, [data-testid="stFormSubmitButton"] button {
        background-color: #ffffff !important;
        color: #1c1c1c !important;
        border: 1px solid #d9d9d9 !important;
        border-radius: 0px !important;
        font-weight: 500 !important;
        padding: 0.4rem 0.9rem !important;
        transition: all 0.12s ease !important;
    }
    .stButton > button:hover, [data-testid="stFormSubmitButton"] button:hover {
        background-color: #f4f4f4 !important;
        border-color: #3ecf8e !important;
    }
    .stButton > button[kind="primary"], .stDownloadButton > button[kind="primary"] {
        background-color: #3ecf8e !important;
        color: #ffffff !important;
        border: 1px solid #3ecf8e !important;
    }
    .stButton > button[kind="primary"]:hover {
        background-color: #33b87e !important;
        border-color: #33b87e !important;
    }

    /* ---------- 输入框：直角、细边框、绿聚焦 ---------- */
    .stTextInput input, .stTextArea textarea {
        border: 1px solid #d9d9d9 !important;
        border-radius: 0px !important;
        background: #ffffff !important;
        padding: 0.42rem 0.7rem !important;
        color: #1c1c1c !important;
    }
    .stTextInput input:focus, .stTextArea textarea:focus {
        border-color: #3ecf8e !important;
        box-shadow: 0 0 0 1px #3ecf8e !important;
    }
    [data-testid="stSelectbox"] > div > div,
    [data-testid="stMultiSelect"] > div > div,
    [data-testid="stNumberInput"] > div > div > input {
        border-radius: 0px !important;
        border-color: #d9d9d9 !important;
    }

    /* ---------- 数据表：细线直角 ---------- */
    [data-testid="stDataFrame"], .stDataFrame {
        border: 1px solid #e6e6e6 !important;
        border-radius: 0px !important;
    }

    /* ---------- 指标卡：白底细边框直角 ---------- */
    [data-testid="stMetric"] {
        background: #ffffff !important;
        border: 1px solid #e6e6e6 !important;
        border-radius: 0px !important;
        padding: 0.7rem 1rem !important;
    }
    [data-testid="stMetricValue"] { color: #1c1c1c !important; font-weight: 600 !important; }

    /* ---------- 提示框：细线直角，左侧绿条 ---------- */
    .stAlert { border-radius: 0px !important; border: 1px solid #e6e6e6 !important; border-left: 2px solid #3ecf8e !important; }

    /* ---------- 文件上传：虚细线直角 ---------- */
    [data-testid="stFileUploader"] > div {
        border: 1px dashed #d9d9d9 !important;
        border-radius: 0px !important;
        background: #fafafa !important;
    }
    [data-testid="stFileUploader"] > div:hover {
        border-color: #3ecf8e !important;
        background: #f3fdf7 !important;
    }

    /* ---------- 标签页：底部细线 + 选中绿下划线 ---------- */
    .stTabs [data-baseweb="tab-list"] { border-bottom: 1px solid #e6e6e6 !important; gap: 0 !important; }
    .stTabs [data-baseweb="tab"] { border-radius: 0px !important; }
    .stTabs [aria-selected="true"] { border-bottom: 2px solid #3ecf8e !important; }

    /* ---------- 链接按钮：去圆角 ---------- */
    [data-testid="stLinkButton"] a {
        border-radius: 0px !important;
        border: 1px solid #d9d9d9 !important;
    }
    [data-testid="stLinkButton"] a:hover { border-color: #3ecf8e !important; }

    /* ---------- 侧边栏 logo 文字微调 ---------- */
    section[data-testid="stSidebar"] .stMarkdown p { font-size: 0.9rem !important; }
</style>
""", unsafe_allow_html=True)

# ========== 标题 ==========
st.title(f"📚 {APP_NAME}")
st.markdown(f"版本 v{VERSION} {VERSION_TAG}")

# ========== 初始化 session_state ==========
if 'df' not in st.session_state:
    st.session_state.df = None
if 'processing' not in st.session_state:
    st.session_state.processing = False

# ========== 登录状态 ==========
if 'logged_in' not in st.session_state:
    st.session_state.logged_in = False
if 'user' not in st.session_state:
    st.session_state.user = None
if 'user_id' not in st.session_state:
    st.session_state.user_id = None

# ========== 24小时自动登录（HMAC令牌 + URL/Cookie 双通道持久化） ==========
def _set_login(user):
    st.session_state.logged_in = True
    st.session_state.user = user["username"]
    st.session_state.user_id = user["id"]
    # 恢复该账号自带的API Key（若持久化过）
    try:
        saved = db.get_api_key(user["id"])
        if saved:
            st.session_state.user_api_key = saved
    except Exception:
        pass


def resolve_key_source():
    """返回 (来源, 有效Key)：决定本次提取用谁的Key。
    来源：user(自带Key) / admin(作者Key) / invite(邀请码有效) / None(无权限)
    """
    user_key = st.session_state.get("user_api_key")
    if user_key:
        return "user", user_key
    if st.session_state.get("user") in ADMIN_USERNAMES:
        return "admin", None
    if INVITE_CODE:
        try:
            if db.get_invite(st.session_state.get("user_id")):
                return "invite", None
        except Exception:
            pass
    return None, None


def _ai_ready():
    """AI工作台权限检查：返回 (是否可用, 提示)"""
    src, k = resolve_key_source()
    if src is None and REQUIRE_KEY_OR_INVITE:
        return False, "无 AI 使用权限：请设置自己的 Key 或填写邀请码"
    extract_mod.ACTIVE_API_KEY = k if src == "user" else None
    return True, ""

# 从URL参数恢复登录（刷新/重开网址时）
if not st.session_state.logged_in:
    url_token = st.query_params.get("dsh_token")
    if isinstance(url_token, list):
        url_token = url_token[0] if url_token else None
    if url_token:
        uid = db.validate_session_token(str(url_token))
        if uid:
            user = db.get_user_by_id(uid)
            if user:
                _set_login(user)
        else:
            # 令牌无效或过期：清掉URL参数
            try:
                del st.query_params["dsh_token"]
            except Exception:
                pass

# Cookie -> URL 桥接：重开网址时若Cookie里有令牌，自动补进URL触发登录
components.html("""
<script>
(function(){
  try{
    var m=document.cookie.match(new RegExp('(?:^|; )dsh_token=([^;]*)'));
    if(m){
      var t=decodeURIComponent(m[1]);
      var q=new URLSearchParams(location.search);
      if(!q.get('dsh_token')){ q.set('dsh_token',t); location.replace(location.pathname+'?'+q.toString()); }
    }
  }catch(e){}
})();
</script>
""", height=0)

# 初始化数据库（启动自检：连接异常/缺表时给出明确提示，不阻塞主功能）
db_ok, db_msg = db.init_db()
if not db_ok:
    st.warning(f"⚠️ {db_msg}（提取功能不受影响）")

# ======================== 侧边栏 ========================
with st.sidebar:
    # ----- 用户登录 / 注册 -----
    if not st.session_state.logged_in:
        with st.expander("🔐 登录 / 注册", expanded=True):
            login_tab, register_tab = st.tabs(["登录", "注册"])
            
            with login_tab:
                login_username = st.text_input("用户名", key="login_user")
                login_password = st.text_input("密码", type="password", key="login_pass")
                if st.button("登录", use_container_width=True):
                    user = db.login_user(login_username, login_password)
                    if user:
                        _set_login(user)
                        # 生成24小时令牌：写入URL（刷新/重开保留）+ Cookie（JS自动恢复）
                        token = db.create_session_token(user["id"], hours=24)
                        st.query_params["dsh_token"] = token
                        components.html(f"""
<script>
var d=new Date();d.setTime(d.getTime()+24*3600*1000);
document.cookie='dsh_token={token}; expires='+d.toUTCString()+'; path=/; SameSite=Lax';
</script>
""", height=0)
                        st.success(f"✅ 欢迎回来，{user['username']}！（24小时内免登录）")
                        st.rerun()
                    else:
                        st.error("❌ 用户名或密码错误")
            
            with register_tab:
                reg_username = st.text_input("用户名", key="reg_user")
                reg_password = st.text_input("密码", type="password", key="reg_pass")
                reg_email = st.text_input("邮箱（选填）", key="reg_email")
                reg_qq = st.text_input("QQ号（选填）", key="reg_qq")
                if st.button("注册", use_container_width=True):
                    if len(reg_username) < 2:
                        st.error("❌ 用户名至少2个字符")
                    elif len(reg_password) < 4:
                        st.error("❌ 密码至少4个字符")
                    else:
                        success = db.register_user(reg_username, reg_password, reg_email, reg_qq)
                        if success:
                            st.success("✅ 注册成功！请切换到登录页登录")
                        else:
                            st.error("❌ 用户名已被占用")
    else:
        # 已登录状态
        st.info(f"👤 当前用户：**{st.session_state.user}**")
        if st.button("🚪 退出登录", use_container_width=True):
            st.session_state.logged_in = False
            st.session_state.user = None
            st.session_state.user_id = None
            # 清除URL令牌与Cookie（强制下次重新登录）
            try:
                del st.query_params["dsh_token"]
            except Exception:
                pass
            components.html("""
<script>
document.cookie='dsh_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
</script>
""", height=0)
            st.rerun()
    
    st.markdown("---")
    
    # ----- 参数设置（只在登录后显示）-----
    if st.session_state.logged_in:
        st.header("⚙️ 参数设置")
        book_name = st.text_input("📖 文献名称", value=DEFAULT_BOOK_NAME)
        uploaded_files = st.file_uploader("📄 上传PDF或Word文件", type=['pdf', 'docx'], accept_multiple_files=True)
        st.caption("💡 扫描件建议先用WPS转成Word并让AI修正错字后上传，识别零误差、效果最佳")
        extract_max_only = st.checkbox("🔍 仅提取最大子目（推荐）", value=EXTRACT_MAX_ONLY,
                                       help="只提取【】/“名称：正文”式的最大子目，跳过子目内细分子项（如“船歌”）")

        # ----- 用户自带API Key -----
        with st.expander("🔑 使用自己的API Key（可选）", expanded=False):
            st.caption("用自己的 DeepSeek Key 提取，不占用作者额度；留空则用作者默认Key")
            user_key_input = st.text_input("DeepSeek API Key（sk-…）", type="password",
                                           key="user_api_key_input", placeholder="输入你自己的 Key 并保存")
            if st.button("💾 保存并启用", key="save_user_key"):
                k = (user_key_input or "").strip()
                if not k:
                    st.error("❌ 请输入 Key")
                else:
                    # 轻量验证（DeepSeek余额接口）
                    valid = None
                    try:
                        import requests as _rq
                        resp = _rq.get("https://api.deepseek.com/user/balance",
                                       headers={"Authorization": f"Bearer {k}"}, timeout=10)
                        valid = resp.status_code == 200
                    except Exception:
                        valid = None
                    if valid is False:
                        st.error("❌ Key 无效（DeepSeek 返回未授权），请检查后重试")
                    else:
                        st.session_state.user_api_key = k
                        ok, msg = db.save_api_key(st.session_state.user_id, k)
                        tip = "" if ok else f"（{msg}）"
                        st.success(f"✅ 已启用你的 Key，本次及后续提取将使用它 {tip}")
                        st.rerun()

            # 邀请码：填对后24小时内可用作者Key
            if INVITE_CODE:
                st.markdown("---")
                st.caption("没有自己的 Key？填写作者邀请码可临时使用作者 Key（24小时）")
                invite_input = st.text_input("邀请码", type="password", key="invite_input")
                if st.button("🎟️ 兑换邀请码", key="use_invite"):
                    if invite_input.strip() == INVITE_CODE:
                        if db.save_invite(st.session_state.user_id, INVITE_VALID_HOURS):
                            st.success(f"✅ 兑换成功！{INVITE_VALID_HOURS}小时内可使用作者 Key 提取")
                            st.rerun()
                        else:
                            st.error("❌ 兑换失败（数据库未更新，请确认已执行最新 db_schema.sql）")
                    else:
                        st.error("❌ 邀请码错误")

            # 当前Key来源状态
            source, _key = resolve_key_source()
            if source == "user":
                st.info("👤 当前提取将使用：你的 Key（已设置）")
            elif source == "admin":
                st.info("👑 当前提取将使用：作者 Key（管理员）")
            elif source == "invite":
                st.info("🎟️ 当前提取将使用：作者 Key（邀请码有效期内）")
            else:
                st.warning("⚠️ 当前无提取权限：请设置自己的 Key，或填写邀请码")
            if st.session_state.get("user_api_key") or source == "invite" or source == "admin":
                if st.button("↩️ 恢复默认（作者 Key）", key="reset_user_key"):
                    st.session_state.pop("user_api_key", None)
                    st.rerun()

        start_btn = st.button("🚀 开始智能提取", type="primary", use_container_width=True)
    else:
        st.info("🔒 请先登录后再使用提取功能")
        start_btn = False
        uploaded_files = []
        book_name = DEFAULT_BOOK_NAME

    st.markdown("---")
    
    # ----- 性能配置 -----
    with st.expander("⚡ 性能配置", expanded=False):
        st.caption("调整处理速度和成本")
        
        enable_cache = st.checkbox("启用结果缓存", value=ENABLE_CACHE, 
                                   help="重复处理相同文件时直接返回缓存，零Token消耗")
        enable_ocr = st.checkbox("启用OCR（扫描件识别）", value=ENABLE_OCR,
                                 help="自动识别扫描版PDF（需安装Tesseract）")
        enable_split = st.checkbox("启用长文本智能拆分", value=ENABLE_SPLIT,
                                   help="突破5000字限制，处理大篇幅文献")
        max_workers = st.slider("并行处理数", min_value=1, max_value=4, value=MAX_PARALLEL_WORKERS,
                               help="同时处理多个文件，建议2-3，过高可能触发API限流")
        extract_passes = st.slider("每块抽取轮数", min_value=1, max_value=3, value=EXTRACTION_PASSES,
                                  help="每块调用模型次数并合并去重：1轮省成本，3轮召回最全（API消耗×3）")
        ocr_dpi = st.select_slider("OCR分辨率", options=[150, 200, 300], value=OCR_DPI,
                                  help="300最准（引文改写率14%->4%），150最快；仅对扫描件生效")
    
    st.markdown("---")
    
    # ----- 分类示例管理 -----
    with st.expander("🧠 分类示例管理（Few-shot）", expanded=False):
        st.caption("添加、编辑或删除示例，AI将参照这些示例进行分类")
        
        examples_list = []
        current = {}
        # 匹配 "1. 示例1：" 或 "示例："（排除标题行"以下是一些...示例，..."）
        header_pattern = re.compile(r'^(?:\d+\.\s*)?示例\d*[：:]')
        for line in FEW_SHOT_EXAMPLES.strip().split('\n'):
            line = line.strip()
            if header_pattern.match(line):
                if current:
                    examples_list.append(current)
                    current = {}
            elif line.startswith('- 名称：'):
                current['名称'] = line.replace('- 名称：', '').strip()
            elif line.startswith('- 类别：'):
                current['类别'] = line.replace('- 类别：', '').strip()
            elif line.startswith('- 原因：'):
                current['原因'] = line.replace('- 原因：', '').strip()
        if current:
            examples_list.append(current)
        
        if not examples_list:
            examples_list = [
                {"名称": "盘龙城遗址", "类别": "物质文化", "原因": "考古遗址，实物遗存"},
                {"名称": "荆州抗洪精神", "类别": "精神文化", "原因": "精神价值层面的文化现象"},
            ]
        
        st.caption(f"当前 {len(examples_list)} 个示例")
        
        edited_examples = st.data_editor(
            examples_list,
            use_container_width=True,
            height=200,
            column_config={
                "名称": st.column_config.TextColumn("名称", width="small"),
                "类别": st.column_config.SelectboxColumn("类别", options=CATEGORY_OPTIONS, width="small"),
                "原因": st.column_config.TextColumn("原因", width="medium"),
            },
            num_rows="dynamic"
        )
        
        if st.button("💾 保存示例", use_container_width=True):
            try:
                new_examples = "以下是一些文化要素的分类示例，请严格参照此逻辑进行分类：\n\n"
                for i, ex in enumerate(edited_examples, 1):
                    new_examples += f"{i}. 示例{i}：\n"
                    new_examples += f"   - 名称：{ex.get('名称', '')}\n"
                    new_examples += f"   - 类别：{ex.get('类别', '')}\n"
                    new_examples += f"   - 原因：{ex.get('原因', '')}\n\n"
                
                with open("config.py", "r", encoding="utf-8") as f:
                    config_content = f.read()
                
                pattern = r'FEW_SHOT_EXAMPLES = """[^"]*"""'
                new_config = re.sub(pattern, f'FEW_SHOT_EXAMPLES = """\n{new_examples.strip()}\n"""', config_content)
                
                with open("config.py", "w", encoding="utf-8") as f:
                    f.write(new_config)
                
                st.success("✅ 已保存！下次提取生效")
                st.balloons()
                st.rerun()
            except Exception as e:
                st.error(f"❌ 保存失败：{e}")
    
    st.markdown("---")
    
    # ----- 使用须知 -----
    with st.expander("📖 使用须知", expanded=False):
        st.markdown("""
        **如何使用**
        1. 输入文献名称
        2. 上传PDF或Word文件（扫描件建议先经WPS转Word+AI纠错，效果最佳）
        3. 点击「开始智能提取」
        4. 在表格中编辑数据
        5. 下载Excel结果
        
        **新功能说明**
        - ⚡ 并行处理：同时处理多个文件，大幅提速
        - 💾 结果缓存：重复处理零消耗
        - 🔍 OCR集成：自动识别扫描件
        - 📖 智能拆分：突破5000字限制
        - 🔐 登录/注册系统
        - 💬 用户留言板
        """)
    
    # ----- 更新日志 -----
    with st.expander("📝 更新日志", expanded=False):
        st.markdown("""
        **v4.6.0** (2026-08-16)
        - 🛡️ 管理后台新增"用户统计"：每位用户的ID、提取次数、总条数、
          最近提取时间、平均评分，附总体汇总

        **v4.5.2** (2026-08-16)
        - 🐛 修复多用户同时提取时的文件冲突（每次提取使用独立临时目录）

        **v4.5.0** (2026-08-16) 🚀 正式发布
        - 🎉 车书万里版：一切从今始
        - 🏛️ 工具更名为「杨端明的撷菁轩」
        - 📬 新增联系作者（QQ/邮箱）
        - ✅ 发布前全面检查通过

        **v4.4.0** (2026-08-16)
        - 🎨 界面全新升级：Supabase 风格（白底、直角边框、简约细线条）

        **v4.3.1** (2026-08-16)
        - 🐛 修复 AI 补充时偶发的页面报错

        **v4.3.0** (2026-08-16)
        - 🤖 AI 工作台：一键补充基础信息、自由对话查证、
          一键打开 DeepSeek 网页版继续深入搜索

        **v4.2.0** (2026-08-16)
        - 🗄️ 提取结果自动保存
        - ⭐ 提取后评分与建议（高分结果用于训练回归基准）
        - 🛡️ 管理后台新增提取记录查看与基准生成

        **v4.1.0** (2026-08-16)
        - 📜 历史文献标注来源：《书名》："引文"
        - 🔍 仅提取最大子目（可开关），不再细分到子项

        **v4.0.0** (2026-08-16) 🎉 正式版（车书万里版本）
        - 📄 正式发布：完整工作流（Word路线/子目/OCR/纠错/校验）
        - 📖 新增使用文档与环境变量示例
        - 🧪 发布前全面体检通过

        **v3.6.0** (2026-08-16)
        - 🎟️ 新增邀请码机制
        - 🛡️ 管理后台：留言管理、Key 管理
        - 🔑 Key 来源自动判定

        **v3.5.0** (2026-08-16)
        - 🔑 用户可自带 API Key 提取，不占用作者额度

        **v3.4.0** (2026-08-16)
        - 🧩 代码模块化重构
        - 🧪 新增自动回归测试与轻量学习工具

        **v3.3.0** (2026-08-16)
        - 🛡️ 引文忠实度自动校验（可疑条目自动标记）
        - ⚡ Token 成本优化
        - 🚫 大文件上传限制

        **v3.2.x** (2026-08-16)
        - 🔤 OCR 错字自动纠正
        - 📄 支持 Word 文件（扫描件转 Word 效果最佳）
        - 🔐 24 小时免登录

        **v3.1.x** (2026-08-16)
        - 🔍 OCR 识别质量大幅提升

        **v3.0.0** (2026-08-16)
        - 📚 子目模式：每个子目一条，不再细分

        **v2.9.x** (2026-08-16)
        - 🎯 修复提取遗漏问题
        - 📜 引文忠实度提升

        **v2.7.0** (2026-08-16)
        - 🗺️ 空间字段自动补全省/市

        **v2.6.0** (2026-08-16)
        - 🔍 OCR 增强、跨文件合并、数据库加固

        **v2.5.x** (2026-08-16)
        - 🧠 提取规则全面优化、自动重试、进度条

        **v2.4.0** (2026-08-15)
        - 🎨 UI 美化

        **v2.3.0** (2026-08-14)
        - 🔐 登录/注册、留言板、云端部署

        **v2.2.0** (2026-08-14)
        - 📖 智能拆分、结果缓存、并行处理、OCR 集成

        **v2.1.0** (2026-08-13)
        - 🧠 分类示例管理

        **v2.0.0** (2026-08-13)
        - 🎉 统计看板、在线编辑、进度条

        **v1.0.0** (2026-08-12)
        - 🎉 初始版本：PDF 提取、五类分类、流域识别
        """)
    
    # ----- 致谢 -----
    with st.expander("🙏 致谢", expanded=False):
        st.markdown("""
        **开发者**
        - 失败主义谋士千早爱音

        **联系作者**
        - QQ：169636694
        - 邮箱：youxiang051110@163.com

        **技术栈**
        - Python 3.14, Streamlit 1.61
        - DeepSeek API, PyMuPDF
        - Pandas, OpenPyXL, Tesseract
        - Supabase (PostgreSQL)

        **特别感谢**
        - DeepSeek和Claude提供的强大AI能力
        - 王小波和纪德深邃动人的文学
        - 所有为本工具提供建议和机器学习素材的朋友们
        - 清华大学开源镜像站和多多软件站伟大的互联网分享精神
        - Greenday乐队超棒的音乐
        """)

# ======================== 主界面 ========================

# --- 提取逻辑（增加了 logged_in 检查）---
if start_btn and uploaded_files and st.session_state.logged_in:
    # ========== 调试：按钮被点击 ==========
    print("=== 🔘 按钮被点击了！===", flush=True)
    print(f"上传了 {len(uploaded_files)} 个文件", flush=True)
    sys.stdout.flush()
    
    st.session_state.processing = True
    st.session_state.df = None

    # 每次运行使用独立临时目录（避免多用户/多标签页并发互相删文件）
    os.makedirs("temp_pdfs", exist_ok=True)
    # 清理超过1天的崩溃残留临时目录（幂等，不影响运行中的目录）
    try:
        _now = time.time()
        for _d in glob.glob(os.path.join("temp_pdfs", "run_*")):
            try:
                if os.path.isdir(_d) and _now - os.path.getmtime(_d) > 86400:
                    shutil.rmtree(_d, ignore_errors=True)
            except Exception:
                pass
    except Exception:
        pass
    temp_dir = tempfile.mkdtemp(prefix="run_", dir="temp_pdfs")

    # 拒绝>10MB的单文件（防止大扫描件云端处理超时）
    MAX_UPLOAD_MB = 10
    rejected = [f.name for f in uploaded_files if f.size > MAX_UPLOAD_MB * 1024 * 1024]
    if rejected:
        st.error(f"❌ 以下文件超过 {MAX_UPLOAD_MB}MB 上限，已跳过：{'、'.join(rejected)}"
                 f"（建议先用WPS转Word再上传）")
        uploaded_files = [f for f in uploaded_files if f.size <= MAX_UPLOAD_MB * 1024 * 1024]
        if not uploaded_files:
            st.session_state.processing = False
            st.stop()

    for f in uploaded_files:
        with open(os.path.join(temp_dir, f.name), "wb") as buffer:
            buffer.write(f.getbuffer())

    pdf_paths = [os.path.join(temp_dir, f.name) for f in uploaded_files]
    total = len(pdf_paths)

    progress_bar = st.progress(0, text="初始化...")
    status_text = st.empty()

    # 真实进度回调：主线程按完成顺序更新，避免进度条"假死"
    def update_progress(done, total):
        progress_bar.progress(done / total, text=f"⏳ 正在处理 {done}/{total} 个文件...")

    status_text.info(f"📄 正在并行处理 {total} 个文件（并行数：{max_workers}）...")
    
    # 运行期覆盖模块级参数（OCR分辨率/抽取轮数/API Key）
    import config as app_config
    app_config.OCR_DPI = ocr_dpi       # ocr_engine 动态读 config，此设置全局生效
    extract_mod.OCR_DPI = ocr_dpi      # 兼容旧引用

    # 权限判定：确定本次提取用谁的Key（用户自带 > 管理员/邀请码用作者Key）
    source, user_key = resolve_key_source()
    if source is None and REQUIRE_KEY_OR_INVITE:
        st.error("🔒 你没有提取权限：请设置自己的 DeepSeek Key，或填写作者邀请码（24小时免费使用）")
        st.session_state.processing = False
        st.stop()
    extract_mod.ACTIVE_API_KEY = user_key if source == "user" else None  # 防跨用户串用
    extract_mod.EXTRACT_MAX_ONLY = extract_max_only  # 仅提取最大子目开关
    key_note = {"user": "用户自带Key", "admin": "作者Key(管理员)", "invite": "作者Key(邀请码)"}.get(source, "作者默认Key")
    print(f"📄 开始并行处理 {total} 个文件（OCR:{ocr_dpi}dpi, 每块{extract_passes}轮, {key_note}, 最大子目:{extract_max_only}）...", flush=True)
    try:
        all_entries = process_pdfs_parallel(
            pdf_paths, book_name,
            max_workers=max_workers,
            progress_callback=update_progress,
            extraction_passes=extract_passes
        )
        print(f"✅ 处理完成，共提取 {len(all_entries)} 条", flush=True)
    except Exception as e:
        print(f"❌ 处理出错：{e}", flush=True)
        all_entries = []

    # 清理本次临时目录（ignore_errors：清理失败不阻塞页面）
    shutil.rmtree(temp_dir, ignore_errors=True)
    status_text.empty()
    progress_bar.empty()

    if all_entries:
        df = pd.DataFrame(all_entries)
        cols = ["名称", "类别", "时间", "空间", "流域", "基础信息", "历史文献"]
        for c in cols:
            if c not in df.columns:
                df[c] = ""
        # 历史文献标注来源：《书名》："引文"
        df["历史文献"] = df["历史文献"].map(lambda q: extract_mod.format_quote(q, book_name))
        st.session_state.df = df[cols]
        # 提取结果入库（供管理查看与高分转回归基准）
        src_text = "\n\n".join(getattr(extract_mod, "LAST_SOURCES", []))
        rec_id = db.save_extraction(
            st.session_state.user_id, st.session_state.user,
            book_name, ", ".join(f.name for f in uploaded_files),
            all_entries, src_text)
        st.session_state.last_extraction_id = rec_id if rec_id else None
        st.success(f"🎉 完成！共提取 {len(all_entries)} 条")
        print(f"🎉 完成！共提取 {len(all_entries)} 条", flush=True)
    else:
        st.error("❌ 未提取到数据")
        print("❌ 未提取到数据", flush=True)

    st.session_state.processing = False

# ======================== 评分区（每次提取后） ========================
if st.session_state.get("last_extraction_id"):
    st.markdown("---")
    st.subheader("⭐ 评价本次提取")
    st.caption("评分高的提取结果将被选为回归基准，帮助改进工具")
    rating = st.slider("给本次提取打分（1-10）", 1, 10, 8, key="extract_rating")
    feedback = st.text_input("意见和建议（选填）", key="extract_feedback")
    if st.button("提交评价", key="submit_rating"):
        if db.update_rating(st.session_state.last_extraction_id, rating, feedback):
            st.success("✅ 感谢评价！高分提取将用于训练回归基准")
        else:
            st.error("❌ 提交失败：请确认已执行最新 db_schema.sql（需 extraction_results 表）")

# ======================== 留言板 ========================
if st.session_state.logged_in:
    st.markdown("---")
    st.subheader("💬 用户留言板")
    
    # 提交留言
    with st.form(key="message_form", clear_on_submit=True):
        msg_content = st.text_area("畅所欲言吧朋友们，今天所有的发言由克里斯蒂亚诺·罗纳尔多·多斯·桑托斯·阿伟罗买单！", placeholder="中国基本古籍库是什么冠军？我AI冠军！！！", height=80)
        submit_msg = st.form_submit_button("📤 发布留言")
        if submit_msg and msg_content.strip():
            db.add_message(st.session_state.user_id, st.session_state.user, msg_content.strip())
            st.success("✅ do you hear the people sing?")
            st.rerun()
        elif submit_msg:
            st.error("❌ 棍母了喵")
    
    # 显示留言列表
    messages = db.get_messages(limit=50)
    if messages:
        for msg in messages:
            col1, col2 = st.columns([10, 1])
            with col1:
                st.markdown(f"**{msg['username']}**  ·  {msg['created_at'][:16]}")
                st.markdown(f"{msg['content']}")
                st.markdown("---")
            with col2:
                # 只有留言者本人可以删除
                if msg['user_id'] == st.session_state.user_id:
                    if st.button("🗑️", key=f"del_{msg['id']}"):
                        db.delete_message(msg['id'], st.session_state.user_id)
                        st.rerun()
    else:
        st.info("📭 暂无留言，来做第一个留言的人吧！")

# ======================== 管理后台（仅管理员可见） ========================
def _generate_baselines(min_rating=8):
    """从高评分提取生成回归基准（示例/regression_baselines/*.json）"""
    import json as _json
    recs = db.get_high_rated_extractions(min_rating=min_rating)
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "示例", "regression_baselines")
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for rec in recs:
        try:
            items = _json.loads(rec.get("result_json") or "[]")
            names = [it.get("名称", "") for it in items if it.get("名称")]
            src = rec.get("source_text") or ""
            if not names or len(src) < 100:
                continue
            bl = {"book_name": rec["book_name"], "source_text": src, "golden_names": names}
            with open(os.path.join(out_dir, f"baseline_{rec['id']}.json"), "w", encoding="utf-8") as f:
                _json.dump(bl, f, ensure_ascii=False, indent=2)
            n += 1
        except Exception:
            continue
    return n


if st.session_state.logged_in and st.session_state.get("user") in ADMIN_USERNAMES:
    st.markdown("---")
    st.subheader("🛡️ 管理后台")
    admin_tab1, admin_tab2, admin_tab3, admin_tab4 = st.tabs(
        ["🗑️ 留言管理", "🔑 Key 管理", "📊 提取记录", "👥 用户统计"])

    with admin_tab1:
        st.caption("全部留言（可删除任意一条）")
        all_msgs = db.get_messages(limit=200)
        if all_msgs:
            for m in all_msgs:
                c1, c2 = st.columns([10, 1])
                with c1:
                    st.markdown(f"**{m['username']}** · {str(m['created_at'])[:16]}")
                    st.markdown(f"{m['content']}")
                    st.markdown("---")
                with c2:
                    if st.button("🗑️", key=f"adm_del_{m['id']}"):
                        db.delete_message_any(m["id"])
                        st.rerun()
        else:
            st.info("暂无留言")

    with admin_tab2:
        st.caption("已设置自己 API Key 的用户（Key 为密文，仅可清空）")
        key_users = db.list_users_with_keys()
        if key_users:
            for u in key_users:
                c1, c2 = st.columns([10, 1])
                with c1:
                    st.markdown(f"**{u['username']}** · Key已设置 · 邀请码状态："
                                f"{'✅有效' if db.get_invite(u['id']) else '—'}")
                with c2:
                    if st.button("清空", key=f"adm_key_{u['id']}"):
                        db.clear_api_key(u["id"])
                        st.rerun()
        else:
            st.info("暂无用户设置 Key")

    with admin_tab3:
        st.caption("用户提取记录：评分≥8 可一键生成回归基准")
        if st.button("🎓 从高分提取生成回归基准（评分≥8）", key="gen_baseline"):
            n = _generate_baselines(8)
            st.success(f"✅ 已生成 {n} 个回归基准到 示例/regression_baselines/（下次 _run_regression.py 自动纳入）")
        filter_user = st.text_input("按用户名过滤（留空=全部）", key="adm_extract_user")
        min_rating = st.selectbox("只看评分≥", [0, 6, 8, 9, 10], index=0, key="adm_extract_rating")
        recs = db.list_extractions(limit=100, min_rating=min_rating or None)
        if filter_user:
            recs = [r for r in recs if filter_user in (r.get("username") or "")]
        if recs:
            for r in recs:
                c1, c2 = st.columns([10, 1])
                with c1:
                    st.markdown(f"**{r.get('username','')}** · {r.get('book_name','')} · "
                                f"{r.get('file_name','')} · {r.get('entry_count',0)}条 · "
                                f"评分{r.get('rating') or '—'} · {str(r.get('created_at',''))[:16]}")
                    if r.get("feedback"):
                        st.caption(f"📝 {r['feedback']}")
                    with st.expander("查看条目"):
                        import json as _json2
                        try:
                            items = _json2.loads(r.get("result_json") or "[]")
                            for it in items[:20]:
                                st.markdown(f"- {it.get('名称','')} | {it.get('类别','')} | {it.get('空间','')}")
                            if len(items) > 20:
                                st.caption(f"…共 {len(items)} 条")
                        except Exception:
                            st.caption("（无法解析）")
                with c2:
                    if st.button("🗑️", key=f"adm_extract_del_{r['id']}"):
                        db.delete_extraction(r["id"])
                        st.rerun()
        else:
            st.info("暂无提取记录（确认已执行最新 db_schema.sql，并完成过提取）")

    with admin_tab4:
        st.caption("按用户统计：提取次数 / 总条数 / 最近提取 / 平均评分")
        ustats = db.get_user_stats()
        if ustats:
            col_tot1, col_tot2, col_tot3, col_tot4 = st.columns(4)
            with col_tot1:
                st.metric("👥 用户数", len(ustats))
            with col_tot2:
                st.metric("🔁 总提取次数", sum(u["提取次数"] for u in ustats))
            with col_tot3:
                st.metric("📄 提取总条数", sum(u["总条数"] for u in ustats))
            rated = [u for u in ustats if u["平均评分"]]
            with col_tot4:
                st.metric("⭐ 平均评分",
                          round(sum(u["平均评分"] for u in rated) / len(rated), 1) if rated else "—")
            st.dataframe(pd.DataFrame(ustats),
                         use_container_width=True, hide_index=True,
                         column_config={
                             "user_id": "用户ID",
                             "username": "用户名",
                             "提取次数": st.column_config.NumberColumn("提取次数"),
                             "总条数": st.column_config.NumberColumn("总条数"),
                             "最近提取": "最近提取",
                             "平均评分": st.column_config.NumberColumn("平均评分", format="%.1f"),
                         })
        else:
            st.info("暂无统计数据（确认已执行最新 db_schema.sql，并完成过提取）")

# --- 统计看板 ---
if st.session_state.df is not None and not st.session_state.df.empty:
    df = st.session_state.df
    
    st.markdown("---")
    st.subheader("📊 统计看板")
    
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("📌 总要素数", len(df))
    with col2:
        top_cat = df["类别"].value_counts().index[0] if not df["类别"].empty else "无"
        st.metric("🏷️ 最多类别", top_cat)
    with col3:
        top_river = df["流域"].value_counts().index[0] if not df["流域"].empty else "无"
        st.metric("🌊 主要流域", top_river)
    with col4:
        time_vals = df["时间"].dropna()
        st.metric("⏳ 年代跨度", f"{time_vals.nunique()} 种" if not time_vals.empty else "不详")
    
    col_chart1, col_chart2 = st.columns(2)
    with col_chart1:
        st.caption("类别分布")
        cat_counts = df["类别"].value_counts()
        if not cat_counts.empty:
            st.bar_chart(cat_counts, color="#4CAF50")
    with col_chart2:
        st.caption("流域分布")
        river_counts = df["流域"].value_counts()
        if not river_counts.empty:
            st.bar_chart(river_counts, color="#2196F3")

    # ======================== AI 工作台（统计看板下方、在线编辑上方） ========================
    st.markdown("---")
    st.subheader("🤖 AI 工作台")
    st.caption("用 AI 补充基础信息，然后在线编辑表格；也可打开 DeepSeek 网页版继续深入搜索")
    st.link_button("🌐 打开 DeepSeek 网页版（搜索模式）", "https://chat.deepseek.com/")

    # 条目级补充
    df_now = st.session_state.df
    names_list = df_now["名称"].astype(str).tolist()
    sel_name = st.selectbox("选择要补充的条目", names_list, key="ai_sel")
    if st.button("🧠 AI 补充该条目的基础信息", key="ai_supplement_btn"):
        ok, tip = _ai_ready()
        if not ok:
            st.error(f"🔒 {tip}")
        else:
            row = df_now[df_now["名称"] == sel_name].iloc[0]
            ctx = (f"名称：{row['名称']}\n类别：{row['类别']}\n时间：{row['时间']}\n"
                   f"空间：{row['空间']}\n基础信息：{row['基础信息']}\n"
                   f"历史文献：{str(row['历史文献'])[:200]}")
            msgs = [
                {"role": "system", "content": "你是文史研究助手。请基于条目信息和你的知识，"
                                              "补充更详实的基础信息（史实、背景、意义等），"
                                              "用简洁中文，不超过150字，只输出补充后的基础信息全文。"},
                {"role": "user", "content": ctx},
            ]
            reply = extract_mod.chat_completion(msgs)
            if reply:
                st.session_state.ai_supplement = reply
            else:
                st.error("❌ AI 调用失败（请检查你的 API Key 是否有效/有余额）")
    if st.session_state.get("ai_supplement"):
        st.markdown(f"**🤖 AI 建议补充：**\n\n{st.session_state.ai_supplement}")
        if st.button("📥 写入该条目的基础信息", key="ai_write"):
            df_now.loc[df_now["名称"] == sel_name, "基础信息"] = st.session_state.ai_supplement
            st.session_state.df = df_now
            st.session_state.ai_supplement = None
            st.success("✅ 已写入，可继续在线编辑或下载")
            st.rerun()

    # 自由对话（保留最近几轮）
    with st.expander("💬 自由对话（向 AI 提问/查证）", expanded=False):
        q = st.text_input("你的问题（如：盘龙城遗址的发现过程是怎样的？）", key="ai_q")
        if st.button("发送", key="ai_send"):
            ok, tip = _ai_ready()
            if not ok:
                st.error(f"🔒 {tip}")
            elif q.strip():
                hist = st.session_state.get("ai_history", [])
                hist.append({"role": "user", "content": q.strip()})
                reply = extract_mod.chat_completion(hist[-6:])
                if reply:
                    hist.append({"role": "assistant", "content": reply})
                    st.session_state.ai_history = hist
                else:
                    st.error("❌ AI 调用失败")
        for m in st.session_state.get("ai_history", [])[-8:]:
            role = "🧑" if m["role"] == "user" else "🤖"
            st.markdown(f"{role} **{m['content'][:200] if m['role']=='user' else m['content']}**")

    st.markdown("---")
    st.subheader("✏️ 在线编辑表格")
    
    edited_df = st.data_editor(
        df,
        use_container_width=True,
        height=400,
        column_config={
            "名称": "名称",
            "类别": st.column_config.SelectboxColumn("类别", options=CATEGORY_OPTIONS),
            "流域": st.column_config.SelectboxColumn("流域", options=BASIN_OPTIONS),
            "基础信息": st.column_config.TextColumn("基础信息", width="medium"),
            "历史文献": st.column_config.TextColumn("历史文献", width="large"),
        },
        num_rows="dynamic"
    )
    
    if not edited_df.equals(df):
        st.session_state.df = edited_df
        st.success("✅ 数据已更新")
    
    col_down1, col_down2 = st.columns([1, 5])
    with col_down1:
        output = BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            st.session_state.df.to_excel(writer, index=False)
        excel_data = output.getvalue()
        st.download_button(
            label="📥 下载 Excel",
            data=excel_data,
            file_name=f"{book_name}_{OUTPUT_BASE_NAME}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
        )

else:
    # 未提取数据时显示提示（仅在未登录时显示，登录且未提取时已在上方显示）
    if not st.session_state.logged_in:
        st.info("👈 请先登录，然后上传PDF并点击提取")
    elif st.session_state.df is None:
        st.info("👈 左侧上传PDF并点击提取")

st.markdown("---")
st.caption(f"💡 {APP_NAME} v{VERSION} · 在线修改自动保留 · 数据已上云 ☁️")