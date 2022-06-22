const { expect } = require('chai');
const {
  ethers: { utils, getSigners, getContractFactory, BigNumber },
  waffle: { provider },
} = require('hardhat');

const {
  getBalances,
  getPoolShares,
  computeSwitchInAmount,
  computeSwitchOutAmount,
  computeSharesAmount,
  initPoolAndReturnSharesData,
} = require('./utils');

describe('UniswitchPool', (accounts) => {
  const oneWith18Decimals = utils.parseUnits('1', 18);

  let owner, user;
  let token;
  let factory;
  let pool;

  beforeEach(async () => {
    [owner, user] = await getSigners();

    const TestToken = await getContractFactory('TestToken');
    const UniswitchFactory = await getContractFactory('UniswitchFactory');
    const UniswitchPool = await getContractFactory('UniswitchPool');

    token = await TestToken.deploy('Test Token', 'TTK');
    factory = await UniswitchFactory.deploy();

    const tx = await factory.launchPool(token.address);
    const { events } = await tx.wait();
    const poolAddress = events[0].args.pool;
    pool = UniswitchPool.attach(poolAddress);

    await token.mint(owner.address, oneWith18Decimals);
    await token.mint(user.address, oneWith18Decimals);
    await token.approve(poolAddress, oneWith18Decimals);
    await token.connect(user).approve(poolAddress, oneWith18Decimals);

    hre.tracer.nameTags[owner.address] = 'OWNER';
    hre.tracer.nameTags[user.address] = 'USER';
    hre.tracer.nameTags[factory.address] = 'FACTORY';
    hre.tracer.nameTags[pool.address] = 'POOL';
  });

  describe('initializePool', () => {
    const weiPooled = BigNumber.from(1000000);
    const tokenPooled = BigNumber.from(2000000);

    it('should initialize pool', async () => {
      await pool
        .connect(user)
        .initializePool(tokenPooled, { value: weiPooled });

      const { weiBalance, tokenBalance } = await getBalances(
        pool.address,
        token.balanceOf,
      );
      const { userShares, totalShares } = await getPoolShares(
        user.address,
        pool,
      );
      const k = await pool.k();

      expect(weiBalance).to.equal(weiPooled);
      expect(tokenBalance).to.equal(tokenPooled);
      expect(userShares).to.equal(100000000);
      expect(totalShares).to.equal(100000000);
      expect(k).equal(weiPooled.mul(tokenPooled));
    });

    it('should emit PoolInitialized event', async () => {
      const tx = await pool
        .connect(user)
        .initializePool(tokenPooled, { value: weiPooled });

      await expect(tx)
        .to.emit(pool, 'PoolInitialized')
        .withArgs(pool.address, weiPooled, tokenPooled);
    });

    it('should not initialize pool with less than 100000 ether', async () => {
      await expect(
        pool.initializePool(tokenPooled, { value: 100 }),
      ).to.revertedWith('UniswitchPool: Not enough liquidity provided');
    });

    it('should not initialize pool with less than 100000 tokens', async () => {
      await expect(
        pool.initializePool(100, { value: weiPooled }),
      ).to.revertedWith('UniswitchPool: Not enough liquidity provided');
    });

    it('should not initialize pool if already initialized ', async () => {
      await pool
        .connect(user)
        .initializePool(tokenPooled, { value: weiPooled });

      await expect(
        pool.connect(user).initializePool(tokenPooled, { value: weiPooled }),
      ).to.be.revertedWith('UniswitchPool: Pool already has liquidity');
    });
  });

  describe('provideLiquidity', () => {
    const weiProvided = BigNumber.from(10000);
    const weiDepositForInit = BigNumber.from(2000000);
    const tokenDepositForInit = BigNumber.from(1000000);

    it('should provide liquidity', async () => {
      const { userShares: initialUserShares, totalShares: initialTotalShares } =
        await initPoolAndReturnSharesData(
          user,
          pool,
          tokenDepositForInit,
          weiDepositForInit,
        );

      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiProvided,
        weiDepositForInit,
        tokenDepositForInit,
        initialTotalShares,
      );

      await pool
        .connect(user)
        .provideLiquidity(expectedShareAmount, { value: weiProvided });

      const { weiBalance: finalWeiBalance, tokenBalance: finalTokenBalance } =
        await getBalances(pool.address, token.balanceOf);
      const { userShares: finalUserShares, totalShares: finalTotalShares } =
        await getPoolShares(user.address, pool);

      expect(finalWeiBalance.sub(weiDepositForInit)).equal(weiProvided);
      expect(finalTokenBalance.sub(tokenDepositForInit)).equal(
        expectedTokenAmount,
      );
      expect(finalUserShares.sub(initialUserShares)).equal(expectedShareAmount);
      expect(finalTotalShares.sub(initialTotalShares)).equal(
        expectedShareAmount,
      );
    });

    it('should emit LiquidityProvided event', async () => {
      const { totalShares } = await initPoolAndReturnSharesData(
        user,
        pool,
        tokenDepositForInit,
        weiDepositForInit,
      );

      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiProvided,
        weiDepositForInit,
        tokenDepositForInit,
        totalShares,
      );

      const tx = await pool
        .connect(user)
        .provideLiquidity(expectedShareAmount, { value: weiProvided });

      await expect(tx)
        .to.emit(pool, 'LiquidityProvided')
        .withArgs(
          user.address,
          expectedShareAmount,
          weiProvided,
          expectedTokenAmount,
        );
    });

    it('should not provide liquidity if pool not initialized', async () => {
      await expect(
        pool.connect(user).provideLiquidity(0, { value: weiProvided }),
      ).to.be.revertedWith('UniswitchPool: Pool not initialized');
    });

    it('should not provide liquidity if not enough share received', async () => {
      const { totalShares } = await initPoolAndReturnSharesData(
        user,
        pool,
        tokenDepositForInit,
        weiDepositForInit,
      );

      const { expectedShareAmount } = computeSharesAmount(
        weiProvided,
        weiDepositForInit,
        tokenDepositForInit,
        totalShares,
      );

      await expect(
        pool
          .connect(user)
          .provideLiquidity(expectedShareAmount.add(1), { value: weiProvided }),
      ).to.be.revertedWith('UniswitchPool: Not enough share received');
    });
  });

  describe('withdrawLiquidity', () => {
    const weiDepositForInit = BigNumber.from(2000000);
    const tokenDepositForInit = BigNumber.from(1000000);

    beforeEach(async () => {
      await pool.initializePool(tokenDepositForInit, {
        value: weiDepositForInit,
      });
    });

    it('should withdraw liquidity', async () => {
      const weiWithdrew = BigNumber.from(8000);

      const { userShares: initialUserShares, totalShares: initialTotalShares } =
        await getPoolShares(owner.address, pool);
      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        weiDepositForInit,
        tokenDepositForInit,
        initialTotalShares,
      );

      await pool.withdrawLiquidity(weiWithdrew, expectedTokenAmount);

      const { weiBalance: finalWeiBalance, tokenBalance: finalTokenBalance } =
        await getBalances(pool.address, token.balanceOf);
      const { userShares: finalUserShares, totalShares: finalTotalShares } =
        await getPoolShares(owner.address, pool);

      expect(weiDepositForInit.sub(finalWeiBalance)).equal(weiWithdrew);
      expect(tokenDepositForInit.sub(finalTokenBalance)).equal(
        expectedTokenAmount,
      );
      expect(initialUserShares.sub(finalUserShares)).equal(expectedShareAmount);
      expect(initialTotalShares.sub(finalTotalShares)).equal(
        expectedShareAmount,
      );
    });

    it('should should emit LiquidityWithdrew event', async () => {
      const weiWithdrew = BigNumber.from(8000);

      const { totalShares } = await getPoolShares(owner.address, pool);
      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        weiDepositForInit,
        tokenDepositForInit,
        totalShares,
      );

      await expect(pool.withdrawLiquidity(weiWithdrew, expectedTokenAmount))
        .to.emit(pool, 'LiquidityWithdrew')
        .withArgs(
          owner.address,
          expectedShareAmount,
          weiWithdrew,
          expectedTokenAmount,
        );
    });

    it('should withdraw all liquidity', async () => {
      it('should divest liquidity', async () => {
        await pool.withdrawLiquidity(weiDepositForInit, 0);

        const { weiBalance, tokenBalance } = await getBalances(
          pool.address,
          token.balanceOf,
        );
        const { userShares, totalShares } = await getPoolShares(
          owner.address,
          pool,
        );

        expect(weiBalance).equal(0);
        expect(tokenBalance).equal(0);
        expect(userShares).equal(0);
        expect(totalShares).equal(0);
      });
    });

    it('should correctly withdraw after provide for provider', async () => {
      await pool.connect(user).provideLiquidity(0, { value: 10000000 });

      const weiWithdrew = BigNumber.from(8000);

      const {
        weiBalance: initialWeiBalance,
        tokenBalance: initialTokenBalance,
      } = await getBalances(pool.address, token.balanceOf);
      const { userShares: initialUserShares, totalShares: initialTotalShares } =
        await getPoolShares(user.address, pool);
      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        initialWeiBalance,
        initialTokenBalance,
        initialTotalShares,
      );

      await pool
        .connect(user)
        .withdrawLiquidity(weiWithdrew, expectedTokenAmount);

      const { weiBalance: finalWeiBalance, tokenBalance: finalTokenBalance } =
        await getBalances(pool.address, token.balanceOf);
      const { userShares: finalUserShares, totalShares: finalTotalShares } =
        await getPoolShares(user.address, pool);

      expect(initialWeiBalance.sub(finalWeiBalance)).equal(weiWithdrew);
      expect(initialTokenBalance.sub(finalTokenBalance)).equal(
        expectedTokenAmount,
      );
      expect(initialUserShares.sub(finalUserShares)).equal(expectedShareAmount);
      expect(initialTotalShares.sub(finalTotalShares)).equal(
        expectedShareAmount,
      );
    });

    it('should correctly withdraw after provide for initiator', async () => {
      await pool.connect(user).provideLiquidity(0, { value: 10000000 });

      const weiWithdrew = BigNumber.from(8000);

      const {
        weiBalance: initialWeiBalance,
        tokenBalance: initialTokenBalance,
      } = await getBalances(pool.address, token.balanceOf);
      const { userShares: initialUserShares, totalShares: initialTotalShares } =
        await getPoolShares(owner.address, pool);
      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        initialWeiBalance,
        initialTokenBalance,
        initialTotalShares,
      );

      await pool.withdrawLiquidity(weiWithdrew, expectedTokenAmount);

      const { weiBalance: finalWeiBalance, tokenBalance: finalTokenBalance } =
        await getBalances(pool.address, token.balanceOf);
      const { userShares: finalUserShares, totalShares: finalTotalShares } =
        await getPoolShares(owner.address, pool);

      expect(initialWeiBalance.sub(finalWeiBalance)).equal(weiWithdrew);
      expect(initialTokenBalance.sub(finalTokenBalance)).equal(
        expectedTokenAmount,
      );
      expect(initialUserShares.sub(finalUserShares)).equal(expectedShareAmount);
      expect(initialTotalShares.sub(finalTotalShares)).equal(
        expectedShareAmount,
      );
    });

    it('should correctly withdraw after switch', async () => {
      await pool.connect(user).ethToTokenSwitch(0, { value: 10000000 });

      const weiWithdrew = BigNumber.from(8000);

      const {
        weiBalance: initialWeiBalance,
        tokenBalance: initialTokenBalance,
      } = await getBalances(pool.address, token.balanceOf);
      const { userShares: initialUserShares, totalShares: initialTotalShares } =
        await getPoolShares(owner.address, pool);
      const { expectedShareAmount, expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        initialWeiBalance,
        initialTokenBalance,
        initialTotalShares,
      );

      await pool.withdrawLiquidity(weiWithdrew, expectedTokenAmount);

      const { weiBalance: finalWeiBalance, tokenBalance: finalTokenBalance } =
        await getBalances(pool.address, token.balanceOf);
      const { userShares: finalUserShares, totalShares: finalTotalShares } =
        await getPoolShares(owner.address, pool);

      expect(initialWeiBalance.sub(finalWeiBalance)).equal(weiWithdrew);
      expect(initialTokenBalance.sub(finalTokenBalance)).equal(
        expectedTokenAmount,
      );
      expect(initialUserShares.sub(finalUserShares)).equal(expectedShareAmount);
      expect(initialTotalShares.sub(finalTotalShares)).equal(
        expectedShareAmount,
      );
    });

    it('should not withdraw more than provided', async () => {
      const weiProvided = BigNumber.from(80000);

      await pool.connect(user).provideLiquidity(0, { value: weiProvided });

      await expect(pool.connect(user).withdrawLiquidity(weiProvided.add(1), 0))
        .to.be.reverted;
    });

    it('should not withdraw if not enough tokens in return', async () => {
      const weiWithdrew = BigNumber.from(8000);

      const { totalShares } = await getPoolShares(owner.address, pool);
      const { expectedTokenAmount } = computeSharesAmount(
        weiWithdrew,
        weiDepositForInit,
        tokenDepositForInit,
        totalShares,
      );

      await expect(
        pool.withdrawLiquidity(weiWithdrew, expectedTokenAmount.add(1)),
      ).to.be.revertedWith('UniswitchPool: Not enough token in return');
    });

    it('should not withdraw if not enough liquidity', async () => {
      await expect(
        pool.withdrawLiquidity(weiDepositForInit.add(1), 0),
      ).to.be.revertedWith('UniswitchPool: Not enough shares in the pool');
    });
  });

  describe('Switch', () => {
    const weiDepositForInit = BigNumber.from(200000000);
    const tokenDepositForInit = BigNumber.from(100000000000);

    beforeEach(async () => {
      await pool.initializePool(tokenDepositForInit, {
        value: weiDepositForInit,
      });
    });

    describe('ethToTokenSwitch', () => {
      it('should switch eth for token', async () => {
        const amountSwitched = BigNumber.from(1000000);

        const initialUserTokenBalance = await token.balanceOf(user.address);
        const expectedTokenAmount = computeSwitchOutAmount(
          amountSwitched,
          weiDepositForInit,
          tokenDepositForInit,
          await pool.FEE_RATE(),
        );

        await pool
          .connect(user)
          .ethToTokenSwitch(expectedTokenAmount, { value: amountSwitched });

        const {
          weiBalance: finalPoolWeiBalance,
          tokenBalance: finalPoolTokenBalance,
        } = await getBalances(pool.address, token.balanceOf);
        const finalUserTokenBalance = await token.balanceOf(user.address);

        expect(finalPoolWeiBalance.sub(weiDepositForInit)).to.equal(
          amountSwitched,
        );
        expect(tokenDepositForInit.sub(finalPoolTokenBalance)).to.equal(
          expectedTokenAmount,
        );
        expect(finalUserTokenBalance.sub(initialUserTokenBalance)).to.equal(
          expectedTokenAmount,
        );
      });

      it('should emit EthToTokenSwitched event', async () => {
        const amountSwitched = BigNumber.from(1000000);

        const expectedTokenAmount = computeSwitchOutAmount(
          amountSwitched,
          weiDepositForInit,
          tokenDepositForInit,
          await pool.FEE_RATE(),
        );

        await expect(
          pool
            .connect(user)
            .ethToTokenSwitch(expectedTokenAmount, { value: amountSwitched }),
        )
          .to.emit(pool, 'EthToTokenSwitched')
          .withArgs(user.address, amountSwitched, expectedTokenAmount);
      });

      it('should not swith eth for tokens if not enough tokens out', async () => {
        const amountSwitched = BigNumber.from(1000000);

        const expectedTokenAmount = computeSwitchOutAmount(
          amountSwitched,
          weiDepositForInit,
          tokenDepositForInit,
          await pool.FEE_RATE(),
        );

        await expect(
          pool.connect(user).ethToTokenSwitch(expectedTokenAmount.add(1), {
            value: amountSwitched,
          }),
        ).to.be.revertedWith('UniswitchPool: Not enough tokens received');
      });
    });
  });

  // it('should switch token to eth', async () => {
  //   const weiPooled = 10000000000;
  //   const tokenPooled = 20000000000;
  //   await pool.connect(user).initializePool(tokenPooled, { value: weiPooled });

  //   const initialUserWeiBalance = await provider.getBalance(user.address);
  //   const amountSwitched = 10000000;
  //   const expectedWeiAmount = computeSwitchOutAmount(amountSwitched, tokenPooled, weiPooled);

  //   await pool.connect(user).tokenToEthSwitch(amountSwitched, 0, { gasPrice: 0 });

  //   const { weiBalance: finalPoolWeiBalance, tokenBalance: finalPoolTokenBalance } =
  //     await getBalances(pool.address, token);
  //   const finalUserWeiBalance = await provider.getBalance(user.address);

  //   expect(finalPoolTokenBalance - tokenPooled).to.equal(amountSwitched);
  //   expect(weiPooled - finalPoolWeiBalance).to.equal(expectedWeiAmount);
  //   expect(finalUserWeiBalance.sub(initialUserWeiBalance)).to.equal(expectedWeiAmount);
  // });
});
