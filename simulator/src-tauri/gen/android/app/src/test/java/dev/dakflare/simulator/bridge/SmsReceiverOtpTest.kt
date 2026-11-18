package dev.dakflare.simulator.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsReceiverOtpTest {
    @Test
    fun matchesStandaloneBanglaPinAcrossPunctuationAndWhitespace() {
        val positive = listOf(
            "পিন",
            "আপনার পিন। ১২৩৪",
            "আপনার পিন॥ ১২৩৪",
            "পিন: ১২৩৪",
            "পিন：১২৩৪",
            "পিন—১২৩৪",
            "পিন–১২৩৪",
            "«পিন»",
            "“পিন”",
            "‘পিন’",
            "পিন…১২৩৪",
            "পিন\u200B১২৩৪",
            "\uFEFFপিন",
            "পিন\u09FD১২৩৪",
            "পিন\u09F3১২৩৪",
            "আপনার পিন\u00A0১২৩৪",
            "আপনার পিন\u0085১২৩৪",
            "পিন\u202F১২৩৪",
            "পিন\u2007১২৩৪",
            "পিন\u3000১২৩৪",
            "পিন\uFF65১২৩৪",
            "পিন\uFF61১২৩৪",
            "পিন「১২৩৪",
            "পিন\uFF5F১২৩৪",
            "পিন্টু পিন পাঠিয়েছে",
        )
        for (sample in positive) {
            assertTrue("Expected OTP/PIN match for: $sample", SmsReceiver.isOtpOrPin(sample))
        }
    }

    @Test
    fun matchesEnglishAndMultiWordBanglaKeywords() {
        val positive = listOf(
            "Your OTP is 483920.",
            "Your ＯＴＰ code is 88219",
            "Your PIN is 5432",
            "Your passcode is 1122",
            "Use verification code 998877",
            "Use verification codes 998877",
            "Use authentication code 998877",
            "Your auth code: 1234",
            "Security code 7788",
            "Security codes 7788",
            "Secret code: 4455",
            "secret\u00A0code 4455",
            "Your one-time password is 102938",
            "Your one time password is 102938",
            "Your one  time  password is 102938",
            "otp_123456",
            "pin_code is 1234",
            "user_pin=9988",
            "আপনার ওটিপি কোড হলো ১২৩৪৫৬",
            "আপনার গোপন নম্বর হলো ৫৪২১",
            "গোপন\nপিন কাউকে বলবেন না",
            "গোপন\u202Fপিন কাউকে বলবেন না",
            "আপনার গোলাপী পিন 1234",
            "ভেরিফিকেশন কোড ৫৬৭৮",
            "সিকিউরিটি কোড ৯০১২",
        )
        for (sample in positive) {
            assertTrue("Expected OTP/PIN match for: $sample", SmsReceiver.isOtpOrPin(sample))
        }
    }

    @Test
    fun rejectsBanglaConjunctsAffixesAndEnglishSubstrings() {
        val negative = listOf(
            "পিন্টু আমাকে টাকা পাঠিয়েছে",
            "আপিন",
            "পিনের নম্বর লাগবে না",
            "পিনটি দিন",
            "পিন\u200Cটু",
            "123পিন456",
            "পিন১২৩৪",
            "In my opinion, proceed",
            "Shopping at Pinpoint store",
            "123pin456",
            "mysecret code",
            "secret coder",
            "You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9",
            "",
        )
        for (sample in negative) {
            assertFalse("Expected NO OTP/PIN match for: $sample", SmsReceiver.isOtpOrPin(sample))
        }
    }
}
