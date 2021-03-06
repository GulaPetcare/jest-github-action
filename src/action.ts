import { sep, join } from "path"
import { readFileSync } from "fs"
import { exec } from "@actions/exec"
import * as core from "@actions/core"
import * as github from "@actions/github"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import map from "lodash/map"
import strip from "strip-ansi"
import table from "markdown-table"
import { createCoverageMap, CoverageMapData } from "istanbul-lib-coverage"
import type { FormattedTestResults } from "@jest/test-result/build/types"

const COVERAGE_HEADER = ":loop: **Code coverage**\n\n"

export async function run() {
  const CWD = process.cwd() + sep
  const RESULTS_FILE = join(CWD, "jest.results.json")

  try {
    let token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      token = core.getInput("GITHUB_TOKEN")
    }

    if (!token) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const cmd = getJestCommand(RESULTS_FILE)

    await execJest(cmd)

    // octokit
    const octokit = github.getOctokit(token)

    core.startGroup("Parsing results")
    // Parse results
    const results = parseResults(RESULTS_FILE)
    core.endGroup()

    core.startGroup("Adding check result")
    // Checks
    await octokit.checks.create(getCheckPayload(results, CWD))
    core.endGroup()

    // Coverage comments
    if (shouldCommentCoverage()) {
      core.startGroup("Adding coverage comment")
      const comment = getCoverageTable(results, CWD)
      if (comment) {
        await deletePreviousComments(octokit)
        const commentPayload = getCommentPayload(comment)
        await octokit.issues.createComment(commentPayload)
      }
      core.endGroup()
    }

    if (!results.success) {
      core.setFailed("Some tests failed.")
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error.message)
  }
}

async function deletePreviousComments(octokit: ReturnType<typeof github.getOctokit>) {
  const { data } = await octokit.issues.listComments({
    ...github.context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user.login === "github-actions[bot]" && c.body.startsWith(COVERAGE_HEADER),
      )
      .map((c) =>
        octokit.issues.deleteComment({ ...github.context.repo, comment_id: c.id }),
      ),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

export function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
): string | false {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
  const rows = [["Filename", "Statements", "Branches", "Functions", "Lines"]]

  if (!Object.keys(covMap.data).length) {
    console.error("No entries found in coverage data")
    return false
  }

  for (const [filename, data] of Object.entries(covMap.data || {})) {
    // @ts-ignore
    if (data.toSummary == null) continue

    // @ts-ignore
    const { data: summary } = data.toSummary()
    rows.push([
      filename.replace(cwd, ""),
      summary.statements.pct + "%",
      summary.branches.pct + "%",
      summary.functions.pct + "%",
      summary.lines.pct + "%",
    ])
  }

  return COVERAGE_HEADER + table(rows, { align: ["l", "r", "r", "r", "r"] })
}

function getCommentPayload(body: string) {
  const payload = {
    ...github.context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults, cwd: string) {
  const payload = {
    ...github.context.repo,
    head_sha: getSha(),
    name: core.getInput("command-name"),
    status: undefined,
    conclusion: undefined,
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: getOutputText(results),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }

  // @ts-ignore
  payload.status = "completed" as "completed"
  // @ts-ignore
  payload.conclusion = results.success ? "success" : "failure"

  console.debug("Check payload: %j", payload)
  return payload
}

function getJestCommand(resultsFile: string) {
  let cmd = core.getInput("test-command", { required: false })
  let jestOptions = `--testLocationInResults --json --outputFile="${resultsFile}"`
  if (shouldCommentCoverage()) {
    jestOptions += " --coverage"
  }
  if (shouldRunOnlyChangedFiles() && github.context.payload.pull_request?.base.ref) {
    jestOptions += " --changedSince=" + github.context.payload.pull_request?.base.ref
  }
  return cmd.replace("{{args}}", jestOptions)
}

function parseResults(resultsFile: string): FormattedTestResults {
  const results = JSON.parse(readFileSync(resultsFile, "utf-8"))
  return results
}

async function execJest(cmd: string) {
  try {
    core.startGroup(cmd)
    await exec(cmd, [], { ignoreReturnCode: true })
    console.debug("Jest command executed")
  } catch (e) {
    console.debug("Jest execution failed. Tests have likely failed.")
  }

  core.endGroup()
}

function getPullId(): number {
  return github.context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return github.context.payload.pull_request?.head.sha ?? github.context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Array<{
  path: string
  start_line: number
  end_line: number
  annotation_level: "failure"
  title: string
  message: string
}> => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

const getOutputText = (results: FormattedTestResults) => {
  if (results.success) {
    return
  }
  const entries = filter(map(results.testResults, (r) => strip(r.message)))
  return asMarkdownCode(entries.join("\n"))
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}
