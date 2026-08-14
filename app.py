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
from io import BytesIO

# ========== 调试：强制打印，确认 app.py 已加载 ==========
print("=== app.py 已加载（v2.9.0）===", flush=True)
sys.stdout.flush()

# ========== 导入核心模块（加异常捕获） ==========
try:
    from extract_papers import extract_text_from_pdf, extract_cultural_elements, process_pdfs_parallel
    print("✅ extract_papers 导入成功", flush=True)
except Exception as e:
    print(f"❌ extract_papers 导入失败：{e}", flush=True)
    st.error(f"核心模块导入失败：{e}")
    sys.exit(1)

try:
    from config import (
        CATEGORY_OPTIONS, BASIN_OPTIONS, VERSION, APP_NAME,
        OUTPUT_BASE_NAME, DEFAULT_BOOK_NAME, FEW_SHOT_EXAMPLES,
        MAX_PARALLEL_WORKERS, ENABLE_CACHE, ENABLE_OCR, ENABLE_SPLIT,
        EXTRACTION_PASSES,
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

# ========== 页面配置 ==========
st.set_page_config(page_title=APP_NAME, layout="wide", page_icon="📚")

# ========== UI 美化样式（直接内联注入） ==========
st.markdown("""
<style>
    body {
        background-color: #f8f9fa !important;
        color: #1a202c !important;
    }
    section[data-testid="stSidebar"] {
        background-color: #ffffff !important;
        border-right: 1px solid #e9ecef !important;
    }
    h1, h2, h3 {
        color: #1a202c !important;
        font-weight: 600 !important;
    }
    .stButton > button {
        background-color: #3b82f6 !important;
        color: white !important;
        border-radius: 8px !important;
        border: none !important;
        font-weight: 500 !important;
        padding: 0.5rem 1rem !important;
        transition: all 0.2s ease !important;
    }
    .stButton > button:hover {
        background-color: #2563eb !important;
        box-shadow: 0 4px 12px rgba(59,130,246,0.4) !important;
    }
    .stTextInput input, .stTextArea textarea {
        border-radius: 8px !important;
        border: 1px solid #d1d5db !important;
        padding: 8px 12px !important;
        background-color: #ffffff !important;
    }
    .stTextInput input:focus, .stTextArea textarea:focus {
        border-color: #3b82f6 !important;
        box-shadow: 0 0 0 3px rgba(59,130,246,0.2) !important;
    }
    .stAlert {
        border-radius: 8px !important;
    }
    [data-testid="stMetricValue"] {
        color: #1a202c !important;
        font-weight: 600 !important;
        font-size: 2rem !important;
    }
    .stDownloadButton > button {
        background-color: #10b981 !important;
        color: white !important;
        border-radius: 8px !important;
        border: none !important;
        font-weight: 500 !important;
    }
    .stDownloadButton > button:hover {
        background-color: #059669 !important;
    }
    .stCaption {
        color: #6b7280 !important;
        font-size: 0.9rem !important;
    }
    .streamlit-expanderHeader {
        font-weight: 500 !important;
        color: #1a202c !important;
    }
    .stFileUploader > div {
        border-radius: 8px !important;
        border: 2px dashed #d1d5db !important;
        background-color: #fafafa !important;
    }
    .stFileUploader > div:hover {
        border-color: #3b82f6 !important;
        background-color: #f0f7ff !important;
    }
</style>
""", unsafe_allow_html=True)

# ========== 标题 ==========
st.title(f"📚 {APP_NAME}")
st.markdown(f"版本 {VERSION} — 上传地方志或档案PDF，AI自动提取文化要素")

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
                        st.session_state.logged_in = True
                        st.session_state.user = user["username"]
                        st.session_state.user_id = user["id"]
                        st.success(f"✅ 欢迎回来，{user['username']}！")
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
            st.rerun()
    
    st.markdown("---")
    
    # ----- 参数设置（只在登录后显示）-----
    if st.session_state.logged_in:
        st.header("⚙️ 参数设置")
        book_name = st.text_input("📖 文献名称", value=DEFAULT_BOOK_NAME)
        uploaded_files = st.file_uploader("📄 上传PDF文件", type=['pdf'], accept_multiple_files=True)
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
        2. 上传PDF文件
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
        **v2.9.0** (2026-08-16)
        - 🎯 修复"一份PDF只能提取1条"：模型对同一块多次调用输出极不稳定（1~45条），
          新增"每块多轮抽取并集"（默认3轮，可在性能配置调整），召回大幅提升
        - 📜 历史文献忠实度强化：连续逐字摘录1-3句，禁止省略号/改写/重组语序，
          附格式示例（实测改写率 25% -> 18%）
        - 🏭 提取范围新增产业遗存（盐井/盐场/窑址/矿冶等），对齐人工摘录风格
        - 🔬 参考人工摘录基准（示例/重庆分册），召回对齐达 70%+（含命名变体）

        **v2.7.0** (2026-08-16)
        - 🗺️ 长江流域省域字典：空间字段自动补全省/市（湖北全量+12省市）
        - 📝 基础信息摘要上限放宽至80字，信息量更足
        - 📖 目录页识别：只提取明确实体，不再把章节标题/日期标记当要素
        - 🔗 合并策略升级：按"摘抄句级重叠"判定同一实体，杜绝"佛教/道教协会"类误合并
        - 🔧 查漏补缺：名称去空白、缓存键含OCR/目录标志、进度回调容错

        **v2.6.0** (2026-08-16)
        - 🔍 OCR 增强：灰度化 + 200dpi + 分批转换 + 乱码自动清理（扫描件可用性大幅提升）
        - 🔗 跨文件合并：同一文献的分册/分页提取结果自动合并重复条目
        - 🗄️ 数据库加固：凭据入环境变量、密码加盐、启动自检（缺表/断连有明确提示）
        - 📊 逐块日志：每块提取数量可见，异常低产出会告警

        **v2.5.3** (2026-08-16)
        - 🔗 合并跨块近似重复条目（如"汉阳旧城/汉阳城"），摘抄按句去重拼接
        - 📝 名称修正自动注明"原书作『××』"，保证学术可追溯
        - ⏳ 真实进度条：处理进度实时更新，不再"假死"

        **v2.5.0** (2026-08-16)
        - 🧠 Prompt 全面重构：防编造、输出Schema示例、严格枚举、页码诚实原则
        - 🔧 API 自动重试：网络错误/429/5xx 指数退避，结果更稳定
        - 📦 JSON 输出规范化 + 字段校验：坏数据自动修复/标记
        - 💾 缓存键升级：修改模板或Few-shot后自动失效旧缓存
        - 🐛 修复独立运行 main() 崩溃、超长段落截断等问题

        **v2.4.0** (2026-08-15)
        - 🎨 全面UI美化：Supabase风格卡片设计、柔和配色、圆角按钮
        - ✨ 提升视觉体验：优化输入框、按钮、表格样式
        - 🔧 完善登录/注册交互反馈
        - 📝 使用须知中补充新功能说明

        **v2.3.0** (2026-08-14)
        - 🔐 新增用户登录/注册系统
        - 💬 新增留言板功能（登录后可使用）
        - 📖 反馈请联系作者邮箱youxiang051110@163.com或QQ169636694
        - 🚀 云端部署：工具正式上线 Streamlit Cloud
        - 🔧 工程化改进：系统依赖、环境变量、调试日志
        - 🐛 修复云端OCR依赖缺失、Git敏感信息拦截等问题

        **v2.2.0** (2026-08-14)
        - 📖 新增智能拆分长文献（突破5000字限制）
        - 💾 新增结果缓存（重复处理零Token消耗）
        - ⚡ 新增并行处理（多文件加速50%-70%）
        - 🔍 新增OCR集成（自动识别扫描版PDF）
        - 🔧 新增性能配置面板（前端可调）
        
        **v2.1.0** (2026-08-13)
        - 🧠 新增分类示例管理（可在前端自定义Few-shot示例）
        - ✨ 示例修改后自动保存到config.py
        - 🔧 优化示例解析逻辑
        
        **v2.0.0** (2026-08-13)
        - 🎉 重大更新：统计看板、在线编辑、真实进度条
        - 🔧 配置文件分离、日志系统
        
        **v1.0.0** (2026-08-12)
        - 🎉 初始版本发布
        - 支持PDF文本提取
        - 支持AI自动分类（五类文化维度）
        - 支持流域识别（长江/汉江）
        - 支持自动重命名（文件被占用时）
        """)
    
    # ----- 致谢 -----
    with st.expander("🙏 致谢", expanded=False):
        st.markdown("""
        **开发者**
        - 失败主义谋士千早爱音
        
        **技术栈**
        - Python 3.14, Streamlit 1.61
        - DeepSeek API, PyMuPDF
        - Pandas, OpenPyXL, Tesseract
        - Supabase (PostgreSQL)
        
        **特别感谢**
        - DeepSeek和Claude提供的强大AI能力
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

    temp_dir = "temp_pdfs"
    os.makedirs(temp_dir, exist_ok=True)

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
    
    print(f"📄 开始并行处理 {total} 个文件...", flush=True)
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

    shutil.rmtree(temp_dir)
    status_text.empty()
    progress_bar.empty()

    if all_entries:
        df = pd.DataFrame(all_entries)
        cols = ["名称", "类别", "时间", "空间", "流域", "基础信息", "历史文献"]
        for c in cols:
            if c not in df.columns:
                df[c] = ""
        st.session_state.df = df[cols]
        st.success(f"🎉 完成！共提取 {len(all_entries)} 条")
        print(f"🎉 完成！共提取 {len(all_entries)} 条", flush=True)
    else:
        st.error("❌ 未提取到数据")
        print("❌ 未提取到数据", flush=True)

    st.session_state.processing = False

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