# 代码仓与版本同步要求

## 代码仓信息

- **仓库地址**：<https://github.com/opyamorpen/Value-and-Health-Report>
- **SSH 远端**：`git@github.com:opyamorpen/Value-and-Health-Report.git`
- **默认分支**：`main`
- **可见性**：公开（Public）

## 协作要求

1. **PR + CI 工作流**：`main` 分支已开启分支保护，所有改动必须通过 Pull Request 合入，且 CI（`.github/workflows/ci.yml`）通过后才允许合并；不直接 push 到 `main`。
2. **版本同步**：每次本地改动完成后，必须及时推送到代码仓，保持本地与远端版本一致，不长期保留未推送的本地提交。

## 标准流程

```bash
git checkout -b feat/xxx          # 1. 新建功能分支
# ...本地改动并提交...
git push -u origin feat/xxx       # 2. 推送分支（每次改动后都推）
gh pr create --fill               # 3. 创建 PR，CI 自动运行
gh pr merge --squash --delete-branch  # 4. CI 通过后合并
git checkout main && git pull     # 5. 同步本地 main
```

## CI 检查项（`.github/workflows/ci.yml`）

在 push 到 `main` 和针对 `main` 的 PR 时自动运行：

- 关键文档存在（`README.md`、`REPOSITORY.md`）。
- 凭据文件 `TEST_ENVIRONMENT.md` 不得被提交（仓库为公开仓库，登录凭据严禁入库，已列入 `.gitignore`）。
- 存在 `package.json` 时执行 `npm ci`、构建与测试（脚手架就位后自动生效）。

## 敏感信息提醒

- `TEST_ENVIRONMENT.md`（测试环境地址与登录凭据）只保留在本地，已被 `.gitignore` 排除。
- 如需共享环境信息，请使用私密渠道，不要放入本仓库。
