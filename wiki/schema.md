# Wiki Schema

## Purpose

维护 SunoGrid 项目级 markdown wiki。`raw/` 保存不可变来源,`pages/` 保存综合后的知识页,并通过 `index.md` 和 `log.md` 保持可导航、可追溯。

## Directories

- `raw/`: 不可变原始来源或来源摘录。
- `raw/assets/`: 来源相关附件和图片。
- `pages/sources/`: 单个来源或紧密相关来源包的摘要。
- `pages/entities/`: 稳定实体,例如服务器、仓库、服务、系统。
- `pages/concepts/`: 跨实体复用的机制、流程、风险、决策。
- `pages/analyses/`: 问题驱动的综合结论、runbook 和判断记录。

## Operating Rules

1. 不直接修改 `raw/` 中已有文件;来源变化时新增 raw 记录。
2. 新增或实质更新页面时,同步更新 `index.md` 和 `log.md`。
3. 优先更新已有页面,不要创建语义重复页面。
4. 用相对 markdown 链接连接相关页面。
5. 对事实、解释和开放问题做区分。
6. 可能再次用到的问答结论,沉淀到 `pages/analyses/`。
