export default function Help() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="card">
        <h2 className="mb-2 text-lg font-semibold">📖 使用帮助</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-neutral-700">
          <li>在「提取工作台」上传地方志 PDF 或 Word 文件，填写书名，点击「开始提取」。</li>
          <li>AI 会按五类文化（物质 / 精神 / 制度 / 行为 / 心理）自动提取要素，并标注入选原因与历史文献引文。</li>
          <li>提取完成后可以在线编辑表格、导出 CSV，或用 AI 工作台补充基础信息、自由提问查证。</li>
          <li>给结果评分（1-10），帮助作者改进提取质量。</li>
          <li>没有自己的 Key？可以在管理员的帮助下使用作者 Key 或邀请码。</li>
        </ol>
      </section>

      <section className="card">
        <h2 className="mb-2 text-lg font-semibold">📝 版本日志</h2>
        <ul className="space-y-2 text-sm leading-6 text-neutral-700">
          <li>
            <b>v4.7.0 车书万里</b>：提取更准、界面更顺（当前在线版）
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
        <h2 className="mb-2 text-lg font-semibold">💌 致谢</h2>
        <p className="text-sm leading-6 text-neutral-700">
          致谢王小波和纪德，所有提供建议和素材的朋友们。
          <br />
          开发者：失败主义谋士千早爱音
        </p>
      </section>
    </div>
  )
}
