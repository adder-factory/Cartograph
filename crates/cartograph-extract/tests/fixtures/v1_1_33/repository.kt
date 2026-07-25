package com.example

import java.time.Instant as Moment
import java.util.*

// Runs repository work.
interface Runner : Closeable {
    fun run(value: String): Result
}

enum class State {
    READY,
    FAILED
}

object Helper {
    fun log(value: Any) = println(value)
}

// Stores repository collaborators.
class Repo(
    private val userbo: UserBO,
    var service: Service,
    plain: String,
) : Base(), Runner {
    private val maybe: UserBO? = null
    private val computed: Result = load()

    constructor(userbo: UserBO) : this(userbo, Service(), "plain")

    suspend fun run(value: String = "sk_live_kotlin_default"): Result {
        userbo.toLogin2()
        service.go()
        maybe?.toLogin2()
        service.name
        val made = Widget()
        return Result(made)
    }
}

typealias UserName = String

val topLevel: Repo? = null

fun build(repo: Repo): Repo = repo
