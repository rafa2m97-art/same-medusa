describe("Etapa 1 — foundation", () => {
  it("runs unit tests with no external dependencies", () => {
    expect(1 + 1).toBe(2)
  })

  it("loads required local environment variables", () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(process.env.REDIS_URL).toBeTruthy()
    expect(process.env.JWT_SECRET).toBeTruthy()
    expect(process.env.COOKIE_SECRET).toBeTruthy()
  })
})
