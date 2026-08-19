import { BookOpen, FileText, Globe, Heart, ScrollText } from 'lucide-react'

export default function Help() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <BookOpen size={15} />
            使用帮助
          </span>
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
          <li>在「提取工作台」上传地方志 PDF 或 Word 文件，填写书名，点击「开始提取」。</li>
          <li>AI 会按五类文化（物质 / 精神 / 制度 / 行为 / 心理）自动提取要素，并标注入选原因与历史文献引文。</li>
          <li>提取完成后可以在线编辑表格、导出 CSV，或用 AI 工作台补充基础信息、自由提问查证。</li>
          <li>给结果评分（1-10），帮助作者改进提取质量。</li>
          <li>没有自己的 Key？可以在管理员的帮助下使用作者 Key 或邀请码。</li>
        </ol>
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <FileText size={15} />
            推荐工作流
          </span>
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
          <li><b>首选 Word 文件</b>：地方志能从 WPS / Word 导出 .docx 的话识别最准（文字版 100% 保真）。</li>
          <li><b>PDF 文字版</b>：可直接上传，AI 自动读取文本层。</li>
          <li><b>扫描版 PDF</b>：自动走 OCR 识别，准确率看清晰度；建议先用 WPS 转成 Word（自带 OCR）再上传，效果更好。</li>
          <li>上传后填写书名，便于结果分类、评分与统计。</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <Globe size={15} />
            访问方式
          </span>
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
          <li><b>新地址（推荐）</b>：http://119.91.211.156/ —— 全新界面，速度更快更稳</li>
          <li>旧地址（streamlit.app）仍可访问，作为旧版保留，欢迎随时迁移到新地址</li>
          <li>HTTPS 加密与自定义域名正在安排中</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <ScrollText size={15} />
            版本日志
          </span>
        </h2>
        <ul className="space-y-2 text-sm leading-6">
          <li>
            <b>v5.1.1 赵州无字</b>：历史年代公元化——朝代与唐/宋/元/明/清皇帝年号自动转为公元纪年（如「战国」→ 战国（公元前475年—前221年）、「康熙年间」→ 康熙（公元1662年—1722年）），表格与导出同步生效；选择文件自动识别书名（可修改）；提取结果支持按类别/流域排序筛选，可只导出保留的元素；上传限制提升至 20MB
          </li>
          <li>
            <b>v5.1.0 撷菁新篇</b>：支持一次上传多个文献、提取历史记录、GB/T 与 RIS 引用导出、个人资料页；统计看板新增「本次提取 / 全部数据」双模式、时间趋势与条目热度榜，地图可点击省份下钻到市级
          </li>
          <li>
            <b>v5.0 撷菁新篇</b>：全新界面（React）上线，服务搬到自建服务器，更快更稳；
            支持注册登录、AI 工作台、统计看板、留言板
          </li>
          <li>
            <b>v4.7.0 车书万里</b>：提取更准、界面更顺（旧版）
          </li>
          <li>
            <b>v4.5.0 车书万里</b>：「一切从今始」——OCR 大升级，扫描版地方志也能稳稳提取
          </li>
          <li>
            更早版本：召回率修复、过度提取修复、评分与留言板上线、统计看板上线
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <Heart size={15} />
            致谢
          </span>
        </h2>
        <p className="text-sm leading-6">
          致谢王小波和纪德，所有提供建议和素材的朋友们。
          <br />
          开发者：失败主义谋士千早爱音
        </p>
      </section>
    </div>
  )
}
