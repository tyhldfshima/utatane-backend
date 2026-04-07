// src/services/distributionEngine.ts
// 購入・投げ銭の収益を分配する

import { PoolClient } from 'pg'

const VIEWER_SHARE = 0.05   // 視聴者(購入者)キャッシュバック
const PF_SHARE     = 0.25   // プラットフォーム

/**
 * 購入トランザクションの収益を分配する
 * - 貢献者へ TYP として convertible_balance に加算
 * - 購入者へ 5% キャッシュバック（convertible_balance）
 */
export async function distributeRevenue(
  client: PoolClient,
  transactionId: string,
  versionId: string,
  totalAmount: number,   // 円
  buyerId: string | null
) {
  // 貢献者一覧を取得
  const { rows: contributors } = await client.query(
    `SELECT vc.user_id, vc.role, vc.share_pct
     FROM version_contributors vc
     WHERE vc.version_id=$1`,
    [versionId]
  )

  const distributions: { userId: string; role: string; amount: number }[] = []

  // 貢献者への分配
  for (const c of contributors) {
    const amount = Math.floor(totalAmount * c.share_pct)
    if (amount <= 0) continue
    distributions.push({ userId: c.user_id, role: c.role, amount })
  }

  // 購入者への 5% キャッシュバック
  if (buyerId) {
    const cashback = Math.floor(totalAmount * VIEWER_SHARE)
    if (cashback > 0) {
      distributions.push({ userId: buyerId, role: 'viewer', amount: cashback })
    }
  }

  // DB に記録 & ウォレット更新
  for (const d of distributions) {
    // revenue_distributions に記録
    await client.query(
      `INSERT INTO revenue_distributions (transaction_id, user_id, role, amount, status)
       VALUES ($1,$2,$3,$4,'paid')`,
      [transactionId, d.userId, d.role, d.amount]
    )
    // convertible_balance に加算（円→TYP は 1円=1TYP で運用）
    await client.query(
      `UPDATE users SET convertible_balance = convertible_balance + $1 WHERE id=$2`,
      [d.amount, d.userId]
    )
    // 貢献者へ通知（ループ内でシンプルに）
    if (d.role !== 'viewer') {
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'purchase', $2)`,
        [d.userId, JSON.stringify({ transaction_id: transactionId, amount: d.amount, version_id: versionId })]
      )
    }
  }

  return distributions
}
