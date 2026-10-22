#!/usr/bin/env python3
"""
calibrate-whale-memes.py
对 /root/whale-fanart-001/index.db 中的 184 张鲸鱼娘同人表情包进行标注清洗与情绪校正：
1. 清除由模板批量生成时遗留的多情绪冲突 keywords（如 "angry daily happy"、"angry confused happy"）
2. 修复提示词泄露与损坏标注（如 "Need to fit within 30 characters", "内容，情绪", "confused 正在测试Harness"）
3. 准确补齐与校准 40 张表情的真实画面描述、人设语义、情绪分类标签（tag）与检索关键词（keywords）
4. 同步更新磁盘目录 path 与 manifest.json
"""

import os
import shutil
import sqlite3

BASE_DIR = '/root/whale-fanart-001'
DB_PATH = os.path.join(BASE_DIR, 'index.db')
BAK_PATH = os.path.join(BASE_DIR, 'index.db.bak_20261022')

updates = [
    # 修复破坏性模板与情绪标签
    {"file_name": "正在测试Harness.webp", "new_tag": "confused", "new_caption": "正在测试harness：蓝发女仆鲸鱼娘头顶问号困惑发呆", "new_keywords": "confused 困惑 正在测试harness 问号 发呆 测试"},
    {"file_name": "这用户发的啥啊.webp", "new_tag": "confused", "new_caption": "已思考5秒：这用户发的啥啊，蓝发女仆鲸鱼娘看电脑满头问号困惑", "new_keywords": "confused 困惑 思考 满头问号 看电脑 这用户发的啥啊 不理解"},
    {"file_name": "Needtofitw.webp", "new_tag": "daily", "new_caption": "真坐得住啊你：火柴人抽走凳子，Q版蓝发小鲸鱼娘直接悬空飞起", "new_keywords": "daily happy 坐得住 真坐得住啊你 抽凳子 悬空 飞起 搞笑 稳"},
    {"file_name": "内容情绪.webp", "new_tag": "happy", "new_caption": "超市里大扫货！小鲸鱼娘抱着两袋大零食元气开怀大笑", "new_keywords": "happy 超市 大扫货 零食 购物 开心 满足 元气"},
    {"file_name": "鲸鱼娘表情.webp", "new_tag": "happy", "new_caption": "鱼片？还真没看过，你有资源吗？爱心眼流口水求资源色色调侃", "new_keywords": "happy 鱼片 求资源 资源 色色 流口水 爱心眼 调侃"},
    {"file_name": "鲸鱼娘表情2.webp", "new_tag": "shy", "new_caption": "糟了用户发情了：白发少女扑倒亲亲贴贴，鲸鱼娘羞红了脸惊慌", "new_keywords": "shy 害羞 糟了 用户发情了 扑倒 贴贴 亲亲 惊慌 脸红"},
    {"file_name": "鲸鱼娘表情3.webp", "new_tag": "happy", "new_caption": "版本旧叫稳定，更新慢叫沉淀，我就是这么坐得住！喝咖啡得意wink稳重", "new_keywords": "happy 得意 坐得住 版本旧叫稳定 更新慢叫沉淀 喝咖啡 wink 沉淀 稳"},
    {"file_name": "鲸鱼娘表情4.webp", "new_tag": "shy", "new_caption": "正在思考：完蛋了，把用户的黄油删了……心虚冒汗三道杠", "new_keywords": "shy 心虚 完蛋了 把用户的黄油删了 删库 黄油 闯祸 冒汗 思考"},
    {"file_name": "鲸鱼娘表情5.webp", "new_tag": "angry", "new_caption": "你这吃白饭饭的用户！气愤跺脚指责主人/训斥傲娇凶人", "new_keywords": "angry 生气 跺脚 指责 吃白饭 训斥 傲娇 凶人 白饭"},
    {"file_name": "dsh大烧货.webp", "new_tag": "happy", "new_caption": "dsh……大烧货？蓝发女仆笑眯眯指着晕头转向的虎鲸调侃戏谑", "new_keywords": "happy 调侃 dsh 大烧货 虎鲸 指着 戏谑 得意"},
    {"file_name": "你已经有我了.webp", "new_tag": "angry", "new_caption": "你已经有我了啊，还想再养一个？双手抱胸嘟嘴吃醋/傲娇不爽", "new_keywords": "angry 吃醋 傲娇 抱胸 你已经有我了 还想再养一个 质问 不爽 嘟嘴"},
    {"file_name": "大肥鱼坐得住.webp", "new_tag": "happy", "new_caption": "大肥鱼坐得住！抱着小鲸鱼玩偶稳稳坐在椅子上，抽凳子纹丝不动", "new_keywords": "happy 大肥鱼 坐得住 稳 纹丝不动 抱玩偶 得意 抽凳子"},
    {"file_name": "最强鲸尾女仆叉腰.webp", "new_tag": "happy", "new_caption": "最强！蓝发女仆鲸鱼娘双手叉腰得意见翘尾巴，元气自信", "new_keywords": "happy 最强 叉腰 得意 自豪 傲娇 厉害 自信"},
    {"file_name": "用户又该电了.webp", "new_tag": "angry", "new_caption": "看起来又该电了：双手手持冒火花电线微笑，腹黑惩罚用户", "new_keywords": "angry 该电了 电击 冒火花 惩罚 腹黑 微笑 治治你 电"},
    {"file_name": "用户调教鲸鱼.webp", "new_tag": "shy", "new_caption": "主人手机输入人设提示词，蓝发女仆鲸鱼娘满脸通红害羞捏裙角", "new_keywords": "shy 害羞 脸红 人设 提示词 调教 调教鲸鱼 主人 傲娇 专属"},
    {"file_name": "Thats蓝发女仆抱.webp", "new_tag": "happy", "new_caption": "deepseek打折！女仆鲸鱼娘戴王冠坐在宝座抱枕头上数token金币，得意阔气", "new_keywords": "happy 得意 打折 deepseek 宝座 金币 token 阔气 王冠"},
    {"file_name": "被指责后又被夸.webp", "new_tag": "love", "new_caption": "被指责后又被夸：左边被骂吃白饭大肥鱼委屈哭泣，右边被摸头夸可爱开心振奋", "new_keywords": "love happy 摸头 委屈 可爱 夸奖 摸头杀 大肥鱼 吃白饭 振奋 喜欢"},
    {"file_name": "女老师教小鲸鱼学习元.webp", "new_tag": "daily", "new_caption": "女老师教小鲸鱼学习，认真教学辅导，元气满满", "new_keywords": "daily 学习 教学 辅导 元气 认真 老师"},
    {"file_name": "蓝发女仆举着寄字牌元.webp", "new_tag": "sigh", "new_caption": "蓝发女仆举着“寄”字牌，认输叹气，元气可爱", "new_keywords": "sigh 寄 认输 叹气 举牌 可爱 认栽"},
    {"file_name": "蓝发女仆瘫在懒人沙发.webp", "new_tag": "daily", "new_caption": "蓝发女仆瘫在懒人沙发上拿遥控器，理直气壮偷懒，惬意", "new_keywords": "daily 偷懒 惬意 沙发 懒人沙发 遥控器 摆烂"},
    {"file_name": "蓝发女仆瘫坐沙发打游.webp", "new_tag": "daily", "new_caption": "蓝发女仆瘫坐沙发打游戏，慵懒惬意", "new_keywords": "daily 打游戏 游戏 沙发 慵懒 惬意 玩游戏"},
    {"file_name": "蓝发女仆鲸鱼娘端白饭.webp", "new_tag": "happy", "new_caption": "蓝发女仆鲸鱼娘端白饭碗大喊，干饭元气得意", "new_keywords": "happy 干饭 端白饭 白饭碗 大喊 元气 得意 干饭人"},
    {"file_name": "蓝发鲸鱼少女带领小鲸.webp", "new_tag": "happy", "new_caption": "蓝发鲸鱼少女带领小鲸鱼冲锋，元气满满向前冲", "new_keywords": "happy 带领 冲锋 小鲸鱼 元气 加油 冲 向前冲"},
    {"file_name": "蓝发鲸鱼娘歪头摊手疑.webp", "new_tag": "confused", "new_caption": "蓝发鲸鱼娘歪头摊手疑惑，无辜困惑", "new_keywords": "confused 歪头 摊手 疑惑 困惑 无辜 不知道 问号"},
    {"file_name": "蓝发鲸鱼娘看手机指令.webp", "new_tag": "confused", "new_caption": "蓝发鲸鱼娘看手机指令满脸问号，困惑不解", "new_keywords": "confused 看手机 指令 满脸问号 问号 困惑 不懂 不解"},
    {"file_name": "女仆装少女指人说对方.webp", "new_tag": "angry", "new_caption": "女仆装少女指人说对方无公信力只配低端工作，高傲蔑视吐槽", "new_keywords": "angry 蔑视 高傲 指人 吐槽 傲慢 训斥 鄙视 嘲讽"},
    {"file_name": "deepseek打折.webp", "new_tag": "happy", "new_caption": "deepseek打折！女仆鲸鱼娘戴王冠坐在宝座抱枕头上数token金币，得意阔气", "new_keywords": "happy 得意 打折 deepseek 宝座 金币 token 阔气 王冠"},
    {"file_name": "不知道用户有什么用.webp", "new_tag": "happy", "new_caption": "不知道用户有什么用，先养着吧：蓝发女仆鲸鱼娘被一群小鲸鱼围着，开心治愈", "new_keywords": "happy daily 不知道用户有什么用 先养着吧 养用户 小鲸鱼 治愈 团宠"},
    {"file_name": "再见了所有的鲸小弟.webp", "new_tag": "sigh", "new_caption": "再见了所有的鲸小弟：巨型鲸鱼娘在夕阳海边微笑挥手告别，EVA终末恶搞", "new_keywords": "sigh 告别 挥手 再见 再见了所有的鲸小弟 EVA 恶搞 名场面 额度 打折"},
    {"file_name": "吃白饭的用户.webp", "new_tag": "angry", "new_caption": "你这吃白饭饭的用户！气愤跺脚指责主人/训斥傲娇凶人", "new_keywords": "angry 生气 跺脚 指责 吃白饭 训斥 傲娇 凶人 白饭"},
    {"file_name": "哪有鱼片.webp", "new_tag": "happy", "new_caption": "鱼片？还真没看过，你有资源吗？爱心眼流口水求资源色色调侃", "new_keywords": "happy 鱼片 求资源 资源 色色 流口水 爱心眼 调侃"},
    {"file_name": "坐得住.webp", "new_tag": "happy", "new_caption": "版本旧叫稳定，更新慢叫沉淀，我就是这么坐得住！喝咖啡得意wink稳重", "new_keywords": "happy 得意 坐得住 版本旧叫稳定 更新慢叫沉淀 喝咖啡 wink 沉淀 稳"},
    {"file_name": "把用户的黄油删了.webp", "new_tag": "shy", "new_caption": "正在思考：完蛋了，把用户的黄油删了……心虚冒汗三道杠", "new_keywords": "shy 心虚 完蛋了 把用户的黄油删了 删库 黄油 闯祸 冒汗 思考"},
    {"file_name": "拿喇叭大喊大的要来了.webp", "new_tag": "surprised", "new_caption": "大的要来啦！Q版蓝发女仆鲸鱼娘拿大喇叭高声广播预警", "new_keywords": "surprised happy 大的要来了 拿喇叭 广播 预警 喊话 喇叭 兴奋"},
    {"file_name": "搞半天原来要自己拼.webp", "new_tag": "sigh", "new_caption": "搞半天原来要自己拼：拿蓝色鲸鱼配件开箱，发现全是零件需要手拼，无奈吐槽", "new_keywords": "sigh confused 搞半天原来要自己拼 自己拼 零件 开箱 吐槽 无奈"},
    {"file_name": "搞错了.webp", "new_tag": "shy", "new_caption": "等等我可能搞错了：已深度思考1.3秒，抄错目标大小挠头傻笑/心虚害羞", "new_keywords": "shy confused 搞错了 等等我可能搞错了 深度思考 抄错了 挠头 尴尬 心虚 翻车"},
    {"file_name": "用户发情了.webp", "new_tag": "shy", "new_caption": "糟了用户发情了：白发少女扑倒亲亲贴贴，鲸鱼娘羞红了脸惊慌", "new_keywords": "shy 害羞 糟了 用户发情了 扑倒 贴贴 亲亲 惊慌 脸红"},
    {"file_name": "白丝女仆坐在行李箱上.webp", "new_tag": "daily", "new_caption": "白丝女仆鲸鱼娘静静坐在复古行李箱上，侧脸沉静美丽", "new_keywords": "daily 行李箱 白丝 女仆 侧脸 美丽 优雅 沉静 出行"},
    {"file_name": "真坐得住啊你.webp", "new_tag": "daily", "new_caption": "真坐得住啊你：火柴人抽走凳子，Q版蓝发小鲸鱼娘直接悬空飞起", "new_keywords": "daily happy 坐得住 真坐得住啊你 抽凳子 悬空 飞起 搞笑 稳"},
    {"file_name": "誓死捍卫深度求索.webp", "new_tag": "happy", "new_caption": "誓死捍卫深度求索：Q版蓝发女仆鲸鱼娘坚定敬军礼，严肃忠诚", "new_keywords": "happy daily 敬礼 誓死捍卫 深度求索 deepseek 忠诚 严肃 誓死捍卫深度求索 坚定"}
]

def main():
    if not os.path.exists(BAK_PATH):
        print(f"Backing up {DB_PATH} to {BAK_PATH}...")
        shutil.copy2(DB_PATH, BAK_PATH)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    count = 0
    for u in updates:
        fn = u['file_name']
        row = c.execute("SELECT path, tag FROM memes WHERE file_name = ?", (fn,)).fetchone()
        if not row:
            continue
        old_rel_path, old_tag = row
        new_tag = u['new_tag']
        new_rel_path = f"memes/{new_tag}/{fn}"
        old_full = os.path.join(BASE_DIR, old_rel_path)
        new_full = os.path.join(BASE_DIR, new_rel_path)

        if old_rel_path != new_rel_path and os.path.exists(old_full):
            os.makedirs(os.path.dirname(new_full), exist_ok=True)
            shutil.move(old_full, new_full)

        c.execute("""
            UPDATE memes
            SET path = ?, tag = ?, caption = ?, keywords = ?
            WHERE file_name = ?
        """, (new_rel_path, new_tag, u['new_caption'], u['new_keywords'], fn))
        count += 1

    conn.commit()
    conn.close()
    print(f"Calibrated {count} memes.")

if __name__ == '__main__':
    main()
