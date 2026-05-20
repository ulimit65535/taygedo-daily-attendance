import { createCipheriv, createHash } from 'node:crypto'

const TAYGEDO_BASE_URL = 'https://bbs-api.tajiduo.com'
const LAOHU_BASE_URL = 'https://user.laohu.com'
const LAOHU_SECRET = '89155cc4e8634ec5b1b6364013b23e3e'

export class TaygedoApi {
  constructor(options = {}) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async sendCaptcha(phone, deviceId) {
    const body = signedLaohuBody({
      deviceType: 'LGE-AN10',
      type: '16',
      deviceId,
      deviceName: 'LGE-AN10',
      versionCode: '1',
      t: String(Math.floor(Date.now() / 1000)),
      areaCodeId: '1',
      appId: '10550',
      deviceSys: '12',
      cellphone: phone,
      deviceModel: 'LGE-AN10',
      sdkVersion: '4.129.0',
      bid: 'com.pwrd.htassistant',
      channelId: '1',
    })

    const response = await this.fetchImpl(`${LAOHU_BASE_URL}/m/newApi/sendPhoneCaptchaWithOutLogin`, {
      method: 'POST',
      headers: {
        platform: 'android',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const data = await readJson(response, 'sendCaptcha')
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message ?? data.msg ?? 'sendCaptcha request failed')
    }
  }

  async checkCaptcha(phone, captcha, deviceId) {
    const body = signedLaohuBody({
      deviceType: 'LGE-AN10',
      deviceId,
      deviceName: 'LGE-AN10',
      t: String(Math.floor(Date.now() / 1000)),
      areaCodeId: '1',
      appId: '10550',
      deviceSys: '12',
      cellphone: phone,
      captcha,
      deviceModel: 'LGE-AN10',
      sdkVersion: '4.129.0',
      bid: 'com.pwrd.htassistant',
      channelId: '1',
    })

    const response = await this.fetchImpl(`${LAOHU_BASE_URL}/m/newApi/checkPhoneCaptchaWithOutLogin`, {
      method: 'POST',
      headers: {
        platform: 'android',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const data = await readJson(response, 'checkCaptcha')
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message ?? data.msg ?? 'checkCaptcha request failed')
    }
  }

  async loginWithCaptcha(phone, captcha, deviceId) {
    const body = signedLaohuBody({
      deviceType: 'LGE-AN10',
      idfa: '',
      sign: '',
      adm: '',
      type: '16',
      deviceId,
      version: '1',
      deviceName: 'LGE-AN10',
      mac: '',
      t: String(Date.now()),
      areaCodeId: '1',
      captcha: aesBase64Encode(captcha),
      appId: '10550',
      deviceSys: '12',
      cellphone: aesBase64Encode(phone),
      deviceModel: 'LGE-AN10',
      sdkVersion: '4.129.0',
      bid: 'com.pwrd.htassistant',
      channelId: '1',
    })

    const response = await this.fetchImpl(`${LAOHU_BASE_URL}/openApi/sms/new/login`, {
      method: 'POST',
      headers: {
        platform: 'android',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const data = await readJson(response, 'loginWithCaptcha')
    if (!response.ok || data.code !== 0 || !data.result?.token || data.result.userId === undefined) {
      throw new Error(data.message ?? data.msg ?? 'loginWithCaptcha request failed')
    }

    return {
      token: data.result.token,
      userId: String(data.result.userId),
    }
  }

  async userCenterLogin(token, userId, deviceId) {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/usercenter/api/login`, {
      method: 'POST',
      headers: {
        platform: 'android',
        deviceid: deviceId,
        authorization: '',
        appversion: '1.1.0',
        uid: '10000000',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
      body: formEncode({
        token,
        userIdentity: userId,
        appId: '10551',
      }),
    })

    const data = await readJson(response, 'userCenterLogin')
    if (!response.ok || data.code !== 0 || !data.data?.accessToken || !data.data.refreshToken || data.data.uid === undefined) {
      throw new Error(data.msg ?? 'userCenterLogin request failed')
    }

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken,
      uid: String(data.data.uid),
    }
  }

  async refreshToken(refreshToken, deviceId) {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/usercenter/api/refreshToken`, {
      method: 'POST',
      headers: {
        authorization: refreshToken,
        deviceid: deviceId,
        appversion: '1.1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
    })

    if (response.status === 402) {
      throw new Error('REFRESH_REJECTED_402: refreshToken 已失效，请重新登录')
    }

    const data = await readJson(response, 'refreshToken')
    if (!response.ok || data.code !== 0 || !data.data?.accessToken || !data.data?.refreshToken) {
      throw new Error(data.msg ?? 'refreshToken request failed')
    }

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken,
      uid: data.data.uid === undefined ? undefined : String(data.data.uid),
    }
  }

  async getBindRole(accessToken, uid, gameId = '1256') {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/apihub/api/getGameBindRole?uid=${encodeURIComponent(uid)}&gameId=${encodeURIComponent(gameId)}`, {
      method: 'GET',
      headers: {
        Authorization: accessToken,
      },
    })

    const data = await readJson(response, 'getBindRole')
    if (!response.ok || data.code !== 0 || !data.data) {
      throw new Error(data.msg ?? 'getBindRole request failed')
    }

    return data.data
  }

  async getGameRoles(accessToken, uid, deviceId, gameId = '1256') {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/usercenter/api/v2/getGameRoles?gameId=${encodeURIComponent(gameId)}`, {
      method: 'GET',
      headers: {
        platform: 'android',
        authorization: accessToken,
        uid,
        deviceid: deviceId,
        appversion: '1.1.0',
        'User-Agent': 'okhttp/4.12.0',
      },
    })

    const data = await readJson(response, 'getGameRoles')
    if (!response.ok || data.code !== 0 || !Array.isArray(data.data?.roles)) {
      throw new Error(data.msg ?? 'getGameRoles request failed')
    }

    return {
      roles: data.data.roles
        .filter(role => role.roleId !== undefined)
        .map(role => ({
          roleId: String(role.roleId),
          roleName: role.roleName,
        })),
    }
  }

  async appSignin(accessToken, uid, deviceId) {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/apihub/api/signin`, {
      method: 'POST',
      headers: {
        authorization: accessToken,
        uid,
        deviceid: deviceId,
        appversion: '1.1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
      body: 'communityId=1',
    })

    const data = await readJson(response, 'appSignin')
    if (
      !response.ok
      || data.code !== 0
      || typeof data.data?.exp !== 'number'
      || typeof data.data?.goldCoin !== 'number'
    ) {
      throw new Error(data.msg ?? 'appSignin request failed')
    }

    return {
      exp: data.data.exp,
      goldCoin: data.data.goldCoin,
    }
  }

  async getSigninState(accessToken, gameId = '1256') {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/apihub/awapi/signin/state?gameId=${encodeURIComponent(gameId)}`, {
      method: 'GET',
      headers: {
        Authorization: accessToken,
      },
    })

    const data = await readJson(response, 'getSigninState')
    if (!response.ok || data.code !== 0 || typeof data.data?.days !== 'number') {
      throw new Error(data.msg ?? 'getSigninState request failed')
    }

    return {
      days: data.data.days,
    }
  }

  async getSigninRewards(accessToken, gameId = '1256') {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/apihub/awapi/sign/rewards?gameId=${encodeURIComponent(gameId)}`, {
      method: 'GET',
      headers: {
        Authorization: accessToken,
      },
    })

    const data = await readJson(response, 'getSigninRewards')
    if (!response.ok || data.code !== 0 || !Array.isArray(data.data)) {
      throw new Error(data.msg ?? 'getSigninRewards request failed')
    }

    return data.data
  }

  async gameSignin(accessToken, roleId, gameId = '1256') {
    const response = await this.fetchImpl(`${TAYGEDO_BASE_URL}/apihub/awapi/sign`, {
      method: 'POST',
      headers: {
        authorization: accessToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `roleId=${encodeURIComponent(roleId)}&gameId=${encodeURIComponent(gameId)}`,
    })

    const data = await readJson(response, 'gameSignin')
    if (!response.ok || data.code !== 0) {
      throw new Error(data.msg ?? 'gameSignin request failed')
    }
  }
}

function signedLaohuBody(data) {
  return formEncode({
    ...data,
    sign: laohuSign(data),
  })
}

function laohuSign(data) {
  const values = Object.keys(data).sort().map(key => data[key]).join('')
  return createHash('md5').update(`${values}${LAOHU_SECRET}`, 'utf8').digest('hex')
}

function aesBase64Encode(value) {
  const key = Buffer.from(LAOHU_SECRET.slice(-16), 'utf8')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64')
}

function formEncode(data) {
  return new URLSearchParams(data).toString()
}

async function readJson(response, endpointName) {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`${endpointName} returned invalid JSON (HTTP ${response.status}, empty response)`)
  }

  try {
    return JSON.parse(text)
  }
  catch {
    throw new Error(`${endpointName} returned invalid JSON (HTTP ${response.status}, response: ${summarizeResponse(text)})`)
  }
}

function summarizeResponse(text) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}
